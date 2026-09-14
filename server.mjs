import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HOST = process.env.CODEX_ADAPTER_HOST ?? "127.0.0.1";
const PORT = positiveNumber(process.env.CODEX_ADAPTER_PORT, 8787);
const ROUTER_PATH = process.env.CODEX_ADAPTER_ROUTER
  ?? path.join(__dirname, "router.json");
const CONNECT_TIMEOUT_MS = positiveNumber(process.env.CODEX_ADAPTER_CONNECT_TIMEOUT_MS, 60_000);
const IDLE_TIMEOUT_MS = positiveNumber(process.env.CODEX_ADAPTER_IDLE_TIMEOUT_MS, 120_000);
const MAX_DURATION_MS = positiveNumber(process.env.CODEX_ADAPTER_MAX_DURATION_MS, 900_000);
const MAX_BODY_BYTES = positiveNumber(process.env.CODEX_ADAPTER_MAX_BODY_MB, 16) * 1024 * 1024;
const MAX_CONCURRENCY = positiveNumber(process.env.CODEX_ADAPTER_MAX_CONCURRENCY, 8);

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 10_000;
const STARTED_AT = Date.now();

let activeRequests = 0;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function truncate(value, limit = 200) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function safeJson(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Router: one process serves every provider/account, matched by bearer token.
// ---------------------------------------------------------------------------

function providerEnvKey(name, entry) {
  return entry?.envKey ?? `${name.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function readRouterFile() {
  const parsed = JSON.parse(fs.readFileSync(ROUTER_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("router.json must be an object keyed by provider name");
  }
  return parsed;
}

function routerEnvKeys(config) {
  const keys = [];
  for (const [name, entry] of Object.entries(config)) {
    if (name === "gateway") continue;
    keys.push(providerEnvKey(name, entry));
  }
  for (const envKey of gatewayEnvKeys(config.gateway)) keys.push(envKey);
  return keys;
}

// The gateway key is an optional dedicated client credential that unlocks the
// merged catalog. It is never forwarded upstream; the adapter swaps it for the
// selected provider's own key.
function gatewayEnvKeys(gateway) {
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) return [];
  const names = [];
  if (typeof gateway.clientKeyEnv === "string") names.push(gateway.clientKeyEnv);
  for (const name of gateway.clientKeys ?? []) {
    if (typeof name === "string") names.push(name);
  }
  return names;
}

// Only the credentials referenced by router.json are pulled out of the login
// shell, so a new account only needs a new env var plus a router entry.
function loadShellEnv(envKeys) {
  if (process.env.CODEX_ADAPTER_NO_SHELL_ENV === "1") return;
  const missing = new Set(envKeys.filter((key) => key && !process.env[key]));
  if (missing.size === 0) return;
  const zshenv = path.join(os.homedir(), ".zshenv");
  if (!fs.existsSync(zshenv)) return;
  const result = spawnSync(
    "/bin/zsh",
    ["-lc", `source "${zshenv}" >/dev/null 2>&1; env`],
    { encoding: "utf8", timeout: 5000 }
  );
  if (result.status !== 0 || !result.stdout) return;
  for (const line of result.stdout.split("\n")) {
    if (missing.size === 0) break;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    if (!missing.has(key)) continue;
    process.env[key] = line.slice(idx + 1);
    missing.delete(key);
  }
}

function buildRouter(config) {
  const byKey = new Map();
  const byName = new Map();
  const providers = [];
  for (const [name, entry] of Object.entries(config)) {
    if (name === "gateway") continue;
    if (!entry?.upstream) {
      log(`router: skipped "${name}" — missing upstream`);
      continue;
    }
    const envKey = providerEnvKey(name, entry);
    const apiKey = process.env[envKey];
    if (!apiKey) {
      log(`router: skipped "${name}" — env ${envKey} not set`);
      continue;
    }
    const provider = {
      name,
      upstream: entry.upstream,
      envKey,
      apiKey,
      account: entry.account ?? null,
      // "chat" (default) translates Responses <-> Chat Completions.
      // "responses" forwards the Responses payload upstream untouched.
      wire: entry.wire === "responses" ? "responses" : "chat",
      supports: {
        toolChoice: entry.supports?.toolChoice !== false,
        parallelToolCalls: entry.supports?.parallelToolCalls === true,
      },
      timeoutMs: entry.timeoutMs ?? null,
    };
    const existing = byKey.get(apiKey);
    if (existing) {
      log(`router: duplicate bearer key for "${name}" overrides "${existing.name}" — use a distinct envKey per account`);
    }
    byKey.set(apiKey, provider);
    byName.set(name, provider);
    providers.push(provider);
  }

  // Optional gateway client key(s): accepted as a bearer token in place of a
  // provider key. Requests must then name the provider via a slug prefix.
  // These keys are never sent upstream.
  const gatewayKeys = new Set();
  for (const envKey of gatewayEnvKeys(config.gateway)) {
    const value = process.env[envKey];
    if (value) gatewayKeys.add(value);
  }

  return { byKey, byName, providers, gatewayKeys };
}

let ROUTER = { byKey: new Map(), byName: new Map(), providers: [], gatewayKeys: new Set() };

function reloadRouter(reason) {
  let config;
  try {
    config = readRouterFile();
  } catch (error) {
    log(`router: reload failed (${error.message}); keeping ${ROUTER.providers.length} provider(s)`);
    return;
  }
  loadShellEnv(routerEnvKeys(config));
  const next = buildRouter(config);
  ROUTER = next;
  const names = next.providers.map((provider) => provider.name).join(", ") || "none";
  log(`router: ${next.providers.length} provider(s) active (${names}) from ${ROUTER_PATH}${reason ? ` — ${reason}` : ""}`);
}

function resolveProvider(authorization) {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return null;
  const token = match[1].trim();
  return ROUTER.byKey.get(token) ?? (ROUTER.gatewayKeys.has(token) ? { name: "gateway", apiKey: null } : null);
}

// Splits "<provider>/<model>" only when the prefix is a known provider name,
// so upstream model ids that legitimately contain "/" or ":" keep working.
function splitModelPrefix(model) {
  if (typeof model !== "string") return null;
  const idx = model.indexOf("/");
  if (idx <= 0) return null;
  const candidate = ROUTER.byName.get(model.slice(0, idx));
  if (!candidate) return null;
  return { provider: candidate, model: model.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Responses API -> Chat Completions translation
// ---------------------------------------------------------------------------

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part == null) return "";
    if (typeof part === "object") {
      if (typeof part.text === "string") return part.text;
      return JSON.stringify(part);
    }
    return String(part);
  }).join("");
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object") return "";
  return typeof tool.name === "string" ? tool.name : "";
}

// Codex groups some tools in a `type: "namespace"` entry (multi-agent, MCP
// servers). Chat Completions has no nesting, so members are flattened to
// `<namespace>.<tool>` and converted back with the namespace field on the way
// out, which is the shape Codex uses for namespaced calls.
function analyzeTools(request) {
  const custom = new Set();
  const namespaces = new Map();
  const bare = new Map();
  const bareAmbiguous = new Set();
  const flat = new Set();
  for (const tool of request.tools ?? []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "custom" && toolNameOf(tool)) {
      custom.add(tool.name);
      flat.add(tool.name);
      continue;
    }
    if (tool.type !== "namespace" || !toolNameOf(tool)) continue;
    for (const member of tool.tools ?? []) {
      if (member?.type !== "function" || !toolNameOf(member)) continue;
      const entry = {
        namespace: tool.name,
        name: member.name,
        description: member.description ?? "",
        parameters: member.parameters ?? { type: "object", properties: {} },
      };
      namespaces.set(`${tool.name}.${member.name}`, entry);
      flat.add(`${tool.name}.${member.name}`);
      if (bare.has(member.name) || bareAmbiguous.has(member.name)) {
        bareAmbiguous.add(member.name);
        bare.delete(member.name);
      } else {
        bare.set(member.name, entry);
      }
    }
  }
  // A bare member name is only a safe alias when it cannot collide with a real
  // tool name, because models often drop the namespace prefix.
  for (const name of [...bare.keys()]) {
    if (flat.has(name)) bare.delete(name);
  }
  return { custom, namespaces, bare };
}

function toolCallDescriptor(name, index) {
  if (index.custom.has(name)) return { kind: "custom", name };
  const namespaced = index.namespaces.get(name);
  if (namespaced) return { kind: "function", name: namespaced.name, namespace: namespaced.namespace };
  const bare = index.bare.get(name);
  if (bare) return { kind: "function", name: bare.name, namespace: bare.namespace };
  return { kind: "function", name };
}

function historyToolName(item, index) {
  if (item.namespace) {
    const flat = `${item.namespace}.${item.name}`;
    return index.namespaces.has(flat) ? flat : item.name;
  }
  const bare = index.bare.get(item.name);
  return bare ? `${bare.namespace}.${bare.name}` : item.name;
}

// Codex sends `apply_patch` (and other freeform tools) as `type: "custom"`.
// Chat Completions has no freeform tool type, so expose them as function tools
// taking a single `input` string and convert the call back on the way out.
function toChatTools(request, index) {
  const out = [];
  // Order follows the incoming request so the model sees the same tool order
  // Codex declared; namespace members are expanded where the group appears.
  for (const tool of request.tools ?? []) {
    if (!tool || typeof tool !== "object") continue;
    const name = toolNameOf(tool);
    if (tool.type === "function" && name) {
      out.push({
        type: "function",
        function: {
          name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
      });
    } else if (tool.type === "custom" && name) {
      out.push({
        type: "function",
        function: {
          name,
          description: tool.description
            ?? `Freeform tool. Put the complete payload in the "input" string.`,
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Complete freeform payload for this tool." },
            },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
    } else if (tool.type === "local_shell") {
      out.push({
        type: "function",
        function: {
          name: "local_shell",
          description: "Run a shell command in the workspace.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "array", items: { type: "string" } },
              timeout_ms: { type: "integer" },
              working_directory: { type: "string" },
              env: { type: "object" },
            },
            required: ["command"],
          },
        },
      });
    } else if (tool.type === "namespace" && name) {
      for (const [flatName, entry] of index.namespaces) {
        if (entry.namespace !== name) continue;
        out.push({
          type: "function",
          function: {
            name: flatName,
            description: entry.description || `${entry.name} from the ${entry.namespace} namespace.`,
            parameters: entry.parameters,
          },
        });
      }
    } else {
      log(`tool skipped type=${tool.type ?? "unknown"} name=${name || "?"} — not translatable to Chat Completions`);
    }
  }
  return out;
}

function toChatToolChoice(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") {
    return ["auto", "none", "required"].includes(toolChoice) ? toolChoice : undefined;
  }
  if (typeof toolChoice === "object") {
    if (toolChoice.type === "function" || toolChoice.type === "custom") {
      const name = toolChoice.name ?? toolChoice.function?.name;
      if (name) return { type: "function", function: { name } };
    }
    // Chat Completions has no equivalent allow-list; the tool list already
    // restricts what the model may call, so fall back to automatic choice.
    if (toolChoice.type === "allowed_tools") return "auto";
  }
  return undefined;
}

const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

function toChatMessages(body, index) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: contentText(body.instructions) });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
    return messages;
  }
  let pendingAssistant = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    if (pendingAssistant.tool_calls.length === 0) delete pendingAssistant.tool_calls;
    // b.ai (DeepSeek thinking mode) requires `reasoning_content` to be present on every
    // assistant message that issues tool_calls. Pass an empty string when the upstream
    // history has no summary, instead of omitting the field, so b.ai does not reject
    // the request with 400001.
    if (pendingAssistant.tool_calls?.length && pendingAssistant.reasoning_content == null) {
      pendingAssistant.reasoning_content = "";
    }
    if (pendingAssistant.reasoning_content == null) delete pendingAssistant.reasoning_content;
    pendingAssistant = null;
  };
  const startAssistant = () => {
    if (!pendingAssistant) {
      pendingAssistant = { role: "assistant", content: null, tool_calls: [], reasoning_content: null };
      messages.push(pendingAssistant);
    }
    return pendingAssistant;
  };
  for (const item of body.input ?? []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      flushAssistant();
      const role = item.role === "developer" ? "system" : (item.role ?? "user");
      messages.push({ role, content: contentText(item.content) });
    } else if (item.type === "function_call") {
      // Chat Completions needs every parallel call of one turn inside a single
      // assistant message, so consecutive call items are merged here.
      startAssistant().tool_calls.push({
        id: item.call_id,
        type: "function",
        function: { name: historyToolName(item, index), arguments: item.arguments ?? "{}" },
      });
    } else if (item.type === "custom_tool_call") {
      startAssistant().tool_calls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: JSON.stringify({ input: item.input ?? "" }) },
      });
    } else if (item.type === "local_shell_call") {
      startAssistant().tool_calls.push({
        id: item.call_id,
        type: "function",
        function: { name: "local_shell", arguments: JSON.stringify(item.action ?? {}) },
      });
    } else if (TOOL_OUTPUT_TYPES.has(item.type)) {
      flushAssistant();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: contentText(item.output) });
    } else if (item.type === "reasoning") {
      // OpenAI Responses API: reasoning items precede the assistant message they belong to.
      // Carry the summary back as `reasoning_content` on the next assistant message so
      // providers like b.ai/DeepSeek that require thinking-mode echoing stay valid.
      const target = startAssistant();
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => part?.text ?? "").join("")
        : contentText(item.summary);
      if (summary) {
        target.reasoning_content = target.reasoning_content
          ? `${target.reasoning_content}\n${summary}`
          : summary;
      }
    }
  }
  flushAssistant();
  return messages;
}

function summarizeInput(input) {
  if (typeof input === "string") return "string";
  if (!Array.isArray(input)) return "none";
  const counts = new Map();
  for (const item of input) {
    const type = item?.type ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(",");
}

function buildChatRequest(request, provider, toolIndex) {
  const chat = {
    model: request.model,
    messages: toChatMessages(request, toolIndex),
    stream: Boolean(request.stream),
  };
  const tools = toChatTools(request, toolIndex);
  if (tools.length > 0) chat.tools = tools;
  if (provider.supports.toolChoice) {
    const toolChoice = toChatToolChoice(request.tool_choice);
    if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  }
  if (provider.supports.parallelToolCalls && typeof request.parallel_tool_calls === "boolean") {
    chat.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (typeof request.temperature === "number") chat.temperature = request.temperature;
  if (typeof request.max_output_tokens === "number") chat.max_tokens = request.max_output_tokens;
  return chat;
}

// ---------------------------------------------------------------------------
// Chat Completions -> Responses API translation
// ---------------------------------------------------------------------------

function responsesUsage(chatUsage) {
  const inputTokens = chatUsage?.prompt_tokens ?? 0;
  const outputTokens = chatUsage?.completion_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: chatUsage?.prompt_tokens_details?.cached_tokens ?? chatUsage?.cached_tokens ?? 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: chatUsage?.completion_tokens_details?.reasoning_tokens ?? chatUsage?.reasoning_tokens ?? 0,
    },
    total_tokens: chatUsage?.total_tokens ?? inputTokens + outputTokens,
  };
}

// Upstream may answer a freeform tool with {"input": "..."} wrapped in JSON,
// with a differently named single key, or with the raw payload string.
function extractCustomInput(rawArguments) {
  if (typeof rawArguments !== "string" || rawArguments === "") return "";
  const trimmed = rawArguments.trim();
  if (!trimmed.startsWith("{")) return rawArguments;
  const parsed = safeJson(trimmed);
  if (parsed == null) return rawArguments;
  if (typeof parsed === "string") return parsed;
  if (typeof parsed !== "object") return rawArguments;
  if (typeof parsed.input === "string") return parsed.input;
  if (parsed.input != null) return JSON.stringify(parsed.input);
  const keys = Object.keys(parsed);
  if (keys.length === 1) {
    const only = parsed[keys[0]];
    return typeof only === "string" ? only : JSON.stringify(only);
  }
  return rawArguments;
}

function toolCallItem(call, toolIndex) {
  const descriptor = toolCallDescriptor(call.name, toolIndex);
  if (descriptor.kind === "custom") {
    return {
      id: call.itemId,
      type: "custom_tool_call",
      status: "completed",
      call_id: call.id,
      name: descriptor.name,
      input: extractCustomInput(call.arguments),
    };
  }
  const item = {
    id: call.itemId,
    type: "function_call",
    status: "completed",
    call_id: call.id,
    name: descriptor.name,
    arguments: call.arguments || "{}",
  };
  if (descriptor.namespace) item.namespace = descriptor.namespace;
  return item;
}

function responsesResult(chat, request, toolIndex) {
  const choice = chat.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  if (message.reasoning_content) {
    output.push({
      id: newId("rs"),
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  if (message.content) {
    output.push({
      id: newId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], text: message.content }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    output.push(toolCallItem({
      id: call.id,
      itemId: newId("fc"),
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }, toolIndex));
  }
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: request.model,
    output,
    output_text: message.content ?? "",
    usage: responsesUsage(chat.usage),
  };
}

function json(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendEvent(res, type, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function failedResponse(request, message, code) {
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    model: request.model,
    error: { code, message: message ?? "Upstream error" },
    usage: responsesUsage(null),
  };
}

function sendFailed(res, request, message, code = "upstream_error") {
  if (res.writableEnded || res.destroyed) return;
  sendEvent(res, "response.failed", { type: "response.failed", response: failedResponse(request, message, code) });
  res.end();
}

function normalizeUpstreamError(status, rawText, parsed) {
  let message = null;
  let code = null;
  const upstream = parsed?.error;
  if (typeof upstream === "string") {
    message = upstream;
  } else if (upstream && typeof upstream === "object") {
    message = upstream.message ?? JSON.stringify(upstream);
    code = upstream.code ?? upstream.type ?? null;
  } else if (parsed?.message) {
    message = parsed.message;
  }
  if (!message) {
    message = rawText ? `Upstream HTTP ${status}: ${truncate(rawText, 200)}` : `Upstream HTTP ${status}`;
    if (/^\s*</.test(rawText ?? "")) message = `Upstream HTTP ${status} (non-JSON response)`;
  }
  const type = status === 429
    ? "rate_limit_error"
    : (status === 401 || status === 403 ? "authentication_error" : (status >= 500 ? "server_error" : "invalid_request_error"));
  return { error: { message, type, code: code ?? undefined } };
}

function extractRetryAfterMs(headers, parsed) {
  const header = headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const bodySeconds = Number(parsed?.error?.retryAfter ?? parsed?.error?.retry_after);
  if (Number.isFinite(bodySeconds)) return Math.max(0, bodySeconds * 1000);
  return null;
}

function describeFailure(error, timing, clientClosed) {
  if (clientClosed.value) {
    return { retryable: false, message: "Client disconnected; upstream request aborted" };
  }
  if (timing.timedOut) {
    const limit = timing.phase === "connect"
      ? CONNECT_TIMEOUT_MS
      : (timing.phase === "idle" ? IDLE_TIMEOUT_MS : MAX_DURATION_MS);
    return { retryable: timing.phase !== "total", message: `Upstream ${timing.phase} timeout after ${limit}ms` };
  }
  return { retryable: true, message: error?.message ?? "upstream request failed" };
}

function sleepWithAbort(ms, res) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish("closed");
    const timer = setTimeout(() => finish("elapsed"), ms);
    res.once("close", onClose);
  });
}

async function streamChat(res, upstream, request, startedAt, session) {
  const { clientClosed, cleanup, bumpIdle, provider, attempt, toolIndex, upstreamRequestId } = session;
  const messageId = newId("msg");
  const responseId = newId("resp");
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model: request.model,
    output: [],
  };
  const state = {
    started: false,
    nextIndex: 0,
    messageIndex: null,
    reasoningIndex: null,
    reasoningId: null,
    reasoningSummaryIndex: 0,
  };

  const startStream = () => {
    if (state.started) return;
    state.started = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    sendEvent(res, "response.created", { type: "response.created", response });
  };

  const ensureReasoningItem = () => {
    if (state.reasoningIndex != null) return;
    state.reasoningId = newId("rs");
    state.reasoningIndex = state.nextIndex++;
    sendEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { id: state.reasoningId, type: "reasoning", summary: [] },
    });
  };

  const ensureMessageItem = () => {
    if (state.messageIndex != null) return;
    state.messageIndex = state.nextIndex++;
    sendEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.messageIndex,
      item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    sendEvent(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: state.messageIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    });
  };

  let buffer = "";
  let text = "";
  let reasoning = "";
  let usage = null;
  let sawError = null;
  let sawChunk = false;
  const toolCalls = new Map();

  const emitLine = (line) => {
    if (!line.startsWith("data:")) {
      if (line.startsWith("event: error")) sawError = sawError ?? "upstream stream error event";
      return;
    }
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    const chunk = safeJson(raw);
    if (chunk == null) return;
    sawChunk = true;
    if (chunk.error) {
      sawError = sawError ?? (typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "upstream error");
      return;
    }
    if (chunk.message && sawError) sawError = chunk.message;
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      startStream();
      ensureReasoningItem();
      sendEvent(res, "response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: state.reasoningId,
        output_index: state.reasoningIndex,
        summary_index: state.reasoningSummaryIndex,
        delta: delta.reasoning_content,
      });
    }
    if (delta.content) {
      text += delta.content;
      startStream();
      ensureMessageItem();
      sendEvent(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        delta: delta.content,
        output_index: state.messageIndex,
        content_index: 0,
      });
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = toolCalls.get(index)
        ?? { id: null, itemId: newId("fc"), name: "", arguments: "", outputIndex: null };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name = call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      toolCalls.set(index, current);
      // Delay the added event until the name is known so custom tools are
      // announced as custom_tool_call instead of function_call.
      if (current.outputIndex == null && current.name) {
        startStream();
        current.id = current.id ?? newId("call");
        current.outputIndex = state.nextIndex++;
        const descriptor = toolCallDescriptor(current.name, toolIndex);
        const item = descriptor.kind === "custom"
          ? {
            id: current.itemId,
            type: "custom_tool_call",
            status: "in_progress",
            call_id: current.id,
            name: descriptor.name,
            input: "",
          }
          : {
            id: current.itemId,
            type: "function_call",
            status: "in_progress",
            call_id: current.id,
            name: descriptor.name,
            arguments: current.arguments || "{}",
          };
        if (descriptor.namespace) item.namespace = descriptor.namespace;
        sendEvent(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: current.outputIndex,
          item,
        });
      }
    }
  };

  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bumpIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) emitLine(line.trim());
    }
  } catch (error) {
    const failure = describeFailure(error, session.timing, clientClosed);
    cleanup();
    if (clientClosed.value) {
      log(`stream aborted provider=${provider.name} model=${request.model} attempt=${attempt} reason=client-disconnected durationMs=${Date.now() - startedAt}`);
      return { done: true };
    }
    if (!state.started) {
      log(`stream failed provider=${provider.name} model=${request.model} attempt=${attempt} error=${failure.message}`);
      return { retryable: failure.retryable, status: 502, message: failure.message, type: "upstream_error" };
    }
    log(`stream error provider=${provider.name} model=${request.model} attempt=${attempt} delivered=partial error=${failure.message}`);
    sendFailed(res, request, failure.message);
    return { done: true };
  }
  cleanup();

  if (sawError && !state.started) {
    log(`stream failed provider=${provider.name} model=${request.model} attempt=${attempt} error=${sawError}`);
    return { retryable: !clientClosed.value, status: 502, message: sawError, type: "upstream_error" };
  }

  const isEmpty = !text && !reasoning && toolCalls.size === 0;
  if (isEmpty && !state.started) {
    log(`stream empty provider=${provider.name} model=${request.model} attempt=${attempt} chunks=${sawChunk ? "yes" : "no"} durationMs=${Date.now() - startedAt}`);
    return { retryable: true, status: 502, message: "Upstream returned an empty response", type: "upstream_error" };
  }

  if (state.messageIndex != null) {
    sendEvent(res, "response.output_text.done", {
      type: "response.output_text.done",
      text,
      output_index: state.messageIndex,
      content_index: 0,
    });
    sendEvent(res, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: state.messageIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], text },
    });
  }
  if (state.reasoningIndex != null) {
    const part = { type: "summary_text", text: reasoning };
    sendEvent(res, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: state.reasoningSummaryIndex,
      text: reasoning,
    });
    const reasoningItem = { id: state.reasoningId, type: "reasoning", summary: [part] };
    response.output.push(reasoningItem);
    sendEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: reasoningItem,
    });
  }
  if (state.messageIndex != null) {
    const messageItem = {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], text }],
    };
    response.output.push(messageItem);
    sendEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.messageIndex,
      item: messageItem,
    });
  }
  const calls = [...toolCalls.values()];
  for (const call of calls) {
    if (call.outputIndex == null) {
      call.id = call.id ?? newId("call");
      call.outputIndex = state.nextIndex++;
    }
  }
  for (const call of calls) {
    const item = toolCallItem(call, toolIndex);
    response.output.push(item);
    sendEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: call.outputIndex,
      item,
    });
  }
  if (sawError) {
    log(`stream failed provider=${provider.name} model=${request.model} attempt=${attempt} error=${sawError} delivered=partial`);
    sendFailed(res, request, sawError);
    return { done: true };
  }

  response.status = "completed";
  response.usage = responsesUsage(usage);
  response.output_text = text;
  sendEvent(res, "response.completed", { type: "response.completed", response });
  res.end();
  log(
    `stream done provider=${provider.name} model=${request.model} attempt=${attempt} text=${text.length}`
    + ` tools=${calls.length} usage=${JSON.stringify(response.usage)} durationMs=${Date.now() - startedAt}`
    + (upstreamRequestId ? ` requestId=${upstreamRequestId}` : "")
  );
  return { done: true };
}

// ---------------------------------------------------------------------------
// Request lifecycle
// ---------------------------------------------------------------------------

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes`);
      error.tooLarge = true;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function attemptUpstream(res, provider, request, chatRequest, toolIndex, startedAt, attempt) {
  const controller = new AbortController();
  const clientClosed = { value: false };
  const timing = { timedOut: false, phase: "connect" };
  const onClose = () => {
    if (!res.writableEnded) {
      clientClosed.value = true;
      controller.abort();
    }
  };
  res.on("close", onClose);

  const hardTimer = setTimeout(() => {
    timing.timedOut = true;
    timing.phase = "total";
    controller.abort();
  }, MAX_DURATION_MS);
  const connectTimer = setTimeout(() => {
    timing.timedOut = true;
    timing.phase = "connect";
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  let idleTimer = null;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timing.timedOut = true;
      timing.phase = "idle";
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const cleanup = () => {
    clearTimeout(hardTimer);
    clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    res.off("close", onClose);
  };

  let upstream;
  try {
    upstream = await fetch(provider.upstream, {
      method: "POST",
      headers: {
        authorization: request.authorization,
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(chatRequest),
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    const failure = describeFailure(error, timing, clientClosed);
    log(`upstream fetch failed provider=${provider.name} model=${request.model} attempt=${attempt} error=${failure.message}`);
    return { retryable: failure.retryable, status: 502, message: failure.message, type: "upstream_error" };
  }
  clearTimeout(connectTimer);
  const upstreamRequestId = upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id") ?? null;

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    cleanup();
    const parsed = safeJson(raw);
    const normalized = normalizeUpstreamError(upstream.status, raw, parsed);
    const retryAfterMs = extractRetryAfterMs(upstream.headers, parsed);
    const retryable = RETRYABLE_STATUS.has(upstream.status) && !clientClosed.value;
    log(
      `upstream http ${upstream.status} provider=${provider.name} model=${request.model} attempt=${attempt}`
      + ` retryable=${retryable} retryAfterMs=${retryAfterMs ?? "n/a"} body=${truncate(raw, 200)}`
      + (upstreamRequestId ? ` requestId=${upstreamRequestId}` : "")
    );
    if (retryAfterMs != null && retryAfterMs > RETRY_AFTER_CAP_MS) {
      return {
        retryable: false,
        status: upstream.status,
        message: `${normalized.error.message} (retry after ${Math.ceil(retryAfterMs / 1000)}s)`,
        type: normalized.error.type,
      };
    }
    return {
      retryable,
      status: upstream.status,
      message: normalized.error.message,
      type: normalized.error.type,
      retryAfterMs,
    };
  }

  if (request.stream) {
    return streamChat(res, upstream, request, startedAt, {
      controller,
      timing,
      clientClosed,
      cleanup,
      bumpIdle,
      provider,
      attempt,
      toolIndex,
      upstreamRequestId,
    });
  }

  bumpIdle();
  let raw;
  try {
    raw = await upstream.text();
  } catch (error) {
    cleanup();
    const failure = describeFailure(error, timing, clientClosed);
    log(`upstream read failed provider=${provider.name} model=${request.model} attempt=${attempt} error=${failure.message}`);
    return { retryable: failure.retryable, status: 502, message: failure.message, type: "upstream_error" };
  }
  cleanup();
  const chat = safeJson(raw);
  if (chat == null) {
    log(`upstream non-json body provider=${provider.name} model=${request.model} attempt=${attempt} bytes=${raw.length}`);
    return { retryable: true, status: 502, message: "Upstream returned invalid JSON", type: "upstream_error" };
  }
  log(
    `non-stream done provider=${provider.name} model=${request.model} attempt=${attempt} durationMs=${Date.now() - startedAt}`
    + (upstreamRequestId ? ` requestId=${upstreamRequestId}` : "")
  );
  json(res, 200, responsesResult(chat, request, toolIndex));
  return { done: true };
}

async function forwardRequest(res, provider, request, chatRequest, toolIndex, startedAt) {
  let attempt = 0;
  let last = { status: 502, message: "Upstream error", type: "upstream_error" };
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const outcome = await attemptUpstream(res, provider, request, chatRequest, toolIndex, startedAt, attempt);
    if (outcome.done) return;
    last = outcome;
    if (!outcome.retryable || attempt >= MAX_ATTEMPTS || res.headersSent) break;
    const delay = Math.max(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1), outcome.retryAfterMs ?? 0);
    log(`retry scheduled provider=${provider.name} model=${request.model} attempt=${attempt} delayMs=${delay} reason=${outcome.message}`);
    if (await sleepWithAbort(delay, res) === "closed") return;
  }
  json(res, last.status ?? 502, { error: { message: last.message, type: last.type ?? "upstream_error" } });
}

// Passthrough for providers that already speak the Responses API wire format
// (e.g. Codex Deka). The original body is forwarded with the bare model id; the
// upstream body is relayed verbatim so no translation can drop fields.
async function forwardResponses(res, provider, request, rawRequest, startedAt) {
  const controller = new AbortController();
  let clientClosed = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  };
  res.on("close", onClose);

  const payload = { ...request, model: request.model };
  // Never leak the client credential or our internal routing markers upstream.
  delete payload.authorization;
  delete payload.requestedModel;

  let upstream;
  try {
    upstream = await fetch(provider.upstream, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    res.off("close", onClose);
    if (clientClosed) return;
    log(`passthrough fetch failed provider=${provider.name} model=${request.model} error=${error.message}`);
    return json(res, 502, { error: { message: error.message, type: "upstream_error" } });
  }

  const upstreamRequestId = upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id") ?? null;
  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    res.off("close", onClose);
    if (clientClosed) return;
    const normalized = normalizeUpstreamError(upstream.status, raw, safeJson(raw));
    log(
      `passthrough http ${upstream.status} provider=${provider.name} model=${request.model}`
      + ` body=${truncate(raw, 200)}` + (upstreamRequestId ? ` requestId=${upstreamRequestId}` : "")
    );
    return json(res, upstream.status, { error: normalized.error });
  }

  if (request.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    } catch (error) {
      if (!clientClosed) log(`passthrough stream failed provider=${provider.name} error=${error.message}`);
    } finally {
      res.off("close", onClose);
      if (!res.writableEnded) res.end();
    }
    const elapsed = Date.now() - startedAt;
    log(`passthrough stream done provider=${provider.name} model=${request.model} durationMs=${elapsed}`);
    return { done: true };
  }

  const raw = await upstream.text().catch((error) => {
    log(`passthrough read failed provider=${provider.name} error=${error.message}`);
    return null;
  });
  res.off("close", onClose);
  if (clientClosed) return { done: true };
  if (raw == null) {
    return json(res, 502, { error: { message: "Upstream read failed", type: "upstream_error" } });
  }
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
  log(`passthrough done provider=${provider.name} model=${request.model} durationMs=${Date.now() - startedAt} bytes=${Buffer.byteLength(raw)}`);
  return { done: true };
}

async function handle(req, res) {
  const startedAt = Date.now();
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, {
      ok: true,
      pid: process.pid,
      uptimeMs: Date.now() - STARTED_AT,
      activeRequests,
      maxConcurrency: MAX_CONCURRENCY,
      providers: ROUTER.providers.map((provider) => ({
        name: provider.name,
        upstream: provider.upstream,
        account: provider.account,
      })),
      gatewayKeys: ROUTER.gatewayKeys.size,
    });
  }
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    log(`route miss ${req.method} ${req.url}`);
    return json(res, 404, { detail: "Not Found" });
  }

  const tokenProvider = resolveProvider(req.headers.authorization);
  if (!tokenProvider) {
    log(`unauthorized bearer token (router has ${ROUTER.providers.length} provider(s))`);
    return json(res, 401, { error: { message: "Unknown or missing API key" } });
  }
  // Provider selection can still be replaced below by a "<provider>/<model>" slug.
  let provider = tokenProvider;
  if (activeRequests >= MAX_CONCURRENCY) {
    log(`busy provider=${provider?.name ?? "gateway"} activeRequests=${activeRequests} limit=${MAX_CONCURRENCY}`);
    return json(res, 429, {
      error: {
        message: `Adapter is handling ${activeRequests} concurrent requests (limit ${MAX_CONCURRENCY})`,
        type: "rate_limit_error",
      },
    });
  }

  let rawBody;
  try {
    rawBody = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    log(`rejected body provider=${provider?.name ?? "gateway"} error=${error.message}`);
    req.destroy();
    return json(res, 413, { error: { message: error.message, type: "invalid_request_error" } });
  }

  const request = safeJson(rawBody);
  if (request == null) {
    log(`invalid json body provider=${provider?.name ?? "gateway"} bytes=${rawBody.length}`);
    return json(res, 400, { error: { message: "Invalid JSON", type: "invalid_request_error" } });
  }
  request.stream = Boolean(request.stream);

  // Route by "<provider>/<model>" prefix when the prefix names a live provider.
  // This lets one client key reach every account in the merged catalog.
  const prefixRoute = splitModelPrefix(request.model);
  if (prefixRoute) {
    provider = prefixRoute.provider;
    request.requestedModel = request.model;
    request.model = prefixRoute.model;
  } else if (provider.apiKey == null) {
    // Gateway key without a usable "<provider>/<model>" prefix: no upstream to
    // authenticate against, so fail loudly instead of sending a bad key.
    log(`gateway: model "${request.model}" has no "<provider>/" prefix`);
    return json(res, 400, {
      error: {
        message: `Model "${request.model}" must use a "<provider>/<model>" slug when using the gateway key.`,
        type: "invalid_request_error",
      },
    });
  }
  request.authorization = `Bearer ${provider.apiKey}`;

  // Providers that already speak the Responses wire format are forwarded
  // verbatim; only Chat-Completions-only providers go through translation.
  if (provider.wire === "responses") {
    log(
      `req(flush) provider=${provider.name} model=${request.model} stream=${request.stream}`
      + (request.requestedModel ? ` slug=${request.requestedModel}` : "")
      + ` bytes=${Buffer.byteLength(rawBody)} input=${summarizeInput(request.input)}`
    );
    activeRequests += 1;
    try {
      await forwardResponses(res, provider, request, rawBody, startedAt);
    } finally {
      activeRequests -= 1;
    }
    return;
  }

  const toolIndex = analyzeTools(request);
  const chatRequest = buildChatRequest(request, provider, toolIndex);
  const chatToolCount = chatRequest.tools?.length ?? 0;
  const requestedToolCount = Array.isArray(request.tools) ? request.tools.length : 0;
  if (requestedToolCount > 0 && chatToolCount === 0) {
    log(`tools requested but none translatable provider=${provider.name} model=${request.model} requested=${requestedToolCount}`);
  }
  log(
    `req provider=${provider.name} model=${request.model} stream=${request.stream}`
    + (request.requestedModel ? ` slug=${request.requestedModel}` : "")
    + ` bytes=${Buffer.byteLength(rawBody)} input=${summarizeInput(request.input)}`
    + ` tools=${chatToolCount}/${requestedToolCount} custom=${toolIndex.custom.size} namespaced=${toolIndex.namespaces.size}`
  );

  activeRequests += 1;
  try {
    await forwardRequest(res, provider, request, chatRequest, toolIndex, startedAt);
  } finally {
    activeRequests -= 1;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

reloadRouter("startup");
fs.watchFile(ROUTER_PATH, { interval: 2000 }, (current, previous) => {
  if (current.mtimeMs !== previous.mtimeMs) reloadRouter("file changed");
});

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    log(`handler error: ${error.stack ?? error.message}`);
    json(res, 502, { error: { message: error.message, type: "upstream_error" } });
  });
});

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") {
    log(`server error: ${error.message}`);
    process.exit(1);
  }
  // Another adapter instance already owns the port. Exiting cleanly keeps
  // launchd (KeepAlive.SuccessfulExit=false) from restarting us forever.
  const probe = http.get({ host: HOST, port: PORT, path: "/health", timeout: 1500 }, (probeRes) => {
    const chunks = [];
    probeRes.on("data", (chunk) => chunks.push(chunk));
    probeRes.on("end", () => {
      const healthy = probeRes.statusCode === 200 && safeJson(Buffer.concat(chunks).toString("utf8"))?.ok === true;
      log(healthy
        ? `port ${PORT} already served by a healthy adapter — exiting without restart`
        : `listen failed (EADDRINUSE) and the existing listener is not a healthy adapter`);
      process.exit(healthy ? 0 : 1);
    });
  });
  probe.on("timeout", () => probe.destroy(new Error("health probe timed out")));
  probe.on("error", (probeError) => {
    log(`listen failed (EADDRINUSE) and health probe failed: ${probeError.message}`);
    process.exit(1);
  });
});

process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error.stack ?? error.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} pid=${process.pid} node=${process.version} providers=${ROUTER.providers.length} maxConcurrency=${MAX_CONCURRENCY}`);
});
