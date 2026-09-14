#!/usr/bin/env node
//
// Build a Codex model catalog for a Responses-native provider by querying its
// OpenAI-compatible /v1/models endpoint.
//
// Usage:
//   node scripts/build-responses-catalog.mjs \
//     --out /Users/macbook/.codex/model-catalogs/codexdeka.json \
//     --base-url https://codex2.deka.dev/v1 \
//     --env-key CODEXDEKA_API_KEY \
//     --label "Codex Deka"
//
// The env var is read from the environment and from ~/.zshenv, and is never
// printed. Existing catalog entries are preserved by slug so hand-tuned
// metadata (context window, reasoning levels) survives a refresh.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unrecognized argument: ${arg}`);
    out[arg.slice(2)] = argv[++i];
  }
  for (const required of ["out", "base-url", "env-key"]) {
    if (!out[required]) throw new Error(`--${required} is required`);
  }
  return out;
}

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  const zshenv = path.join(os.homedir(), ".zshenv");
  if (!fs.existsSync(zshenv)) return null;
  const result = spawnSync(
    "/bin/zsh",
    ["-lc", `source "${zshenv}" >/dev/null 2>&1; print -rn -- "$${key}"`],
    { encoding: "utf8", timeout: 5000 }
  );
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning for coding tasks" },
  { effort: "high", description: "More reasoning for complex tasks" },
];

const BASE_INSTRUCTIONS = "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is handled.";

function templateEntry(id, { displayName, description, priority }) {
  return {
    slug: id,
    display_name: displayName,
    description,
    default_reasoning_level: "medium",
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: BASE_INSTRUCTIONS,
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = readEnv(args["env-key"]);
  if (!apiKey) throw new Error(`${args["env-key"]} is not set (checked env and ~/.zshenv)`);

  const baseUrl = args["base-url"].replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${baseUrl}/models -> HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const payload = await response.json();
  // Two shapes in the wild:
  //   { data: [{ id, display_name, ... }] }  (OpenAI-compatible)
  //   { models: [{ slug, display_name, ... }] }  (Codex catalog)
  const listed = Array.isArray(payload?.data)
    ? payload.data.map((model) => ({ id: model.id, displayName: model.display_name }))
    : (Array.isArray(payload?.models)
      ? payload.models.map((model) => ({ id: model.slug, displayName: model.display_name, full: model }))
      : []);
  if (listed.length === 0) throw new Error(`GET ${baseUrl}/models returned no models`);

  // Preserve existing metadata (context window, reasoning levels) by slug.
  let previous = [];
  if (fs.existsSync(args.out)) {
    try {
      previous = JSON.parse(fs.readFileSync(args.out, "utf8")).models ?? [];
    } catch { previous = []; }
  }
  const previousBySlug = new Map(previous.map((model) => [model.slug, model]));

  const label = args.label ?? baseUrl;
  const models = listed
    // Skip wildcard/placeholder ids (e.g. "claude-*") that are not real models.
    .filter((model) => typeof model?.id === "string" && model.id.length > 0 && !model.id.includes("*"))
    .map((model, index) => {
      const existing = previousBySlug.get(model.id);
      if (existing) return { ...existing, priority: index + 1 };
      // Providers that already return a full Codex catalog entry can be used
      // as-is, keeping upstream-declared context windows and reasoning levels.
      if (model.full) return { ...model.full, priority: index + 1 };
      return templateEntry(model.id, {
        displayName: model.displayName ?? model.id,
        description: `${model.id} served by ${label}.`,
        priority: index + 1,
      });
    });

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
  const reused = models.filter((model) => previousBySlug.has(model.slug)).length;
  console.log(`${label}: ${models.length} models (${reused} preserved, ${models.length - reused} new) -> ${args.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
