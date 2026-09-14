#!/usr/bin/env node
//
// Merge the per-provider Codex model catalogs into a single catalog that the
// shared adapter can serve. Each model slug is prefixed with `<provider>/` so
// the adapter can route it to the right upstream by model name alone.
//
// Usage:
//   node scripts/build-merged-catalog.mjs \
//     --out /Users/macbook/.codex/model-catalogs/merged.json \
//     1if=/Users/macbook/.codex/model-catalogs/1if.json \
//     ontoken=/Users/macbook/.codex/model-catalogs/ontoken.json \
//     bai=/Users/macbook/.codex/model-catalogs/bai.json
//
// Providers that share a slug keep both entries, distinguished by the prefix.

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const sources = [];
  let out = null;
  let defaultProvider = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      out = argv[++i];
    } else if (arg === "--default") {
      defaultProvider = argv[++i];
    } else if (arg.includes("=")) {
      const idx = arg.indexOf("=");
      sources.push({ provider: arg.slice(0, idx), file: arg.slice(idx + 1) });
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (!out) throw new Error("--out <file> is required");
  if (sources.length === 0) throw new Error("at least one <provider>=<catalog.json> source is required");
  return { out, sources, defaultProvider: defaultProvider ?? sources[0].provider };
}

function loadCatalog(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error(`${file}: expected an object with a "models" array`);
  }
  return parsed.models;
}

function buildTemplate(model) {
  // Every catalog entry in this repo already shares the same schema, so the
  // first model of the first catalog is a safe field template. We keep the
  // merged entry explicitly rather than relying on object spread ordering.
  return model;
}

function mergeSlug(provider, slug) {
  return `${provider}/${slug}`;
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Build a display name of the form "<provider> · <model>" with no family
// segment. Upstream names such as "OnToken · Anthropic · claude-opus-4.8" or
// "b.ai · Zhipu · GLM-5.3" get their provider segment reused and the family
// segment dropped, so the provider is never shown twice.
function mergedDisplayName(provider, displayName, fallbackSlug) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  const parts = name.length > 0 ? name.split("·").map((part) => part.trim()).filter(Boolean) : [];
  const providerLabel = parts.length > 0 && normalize(parts[0]).includes(normalize(provider))
    ? parts[0]
    : provider;
  const modelName = parts.length > 0 ? parts[parts.length - 1] : fallbackSlug;
  return `${providerLabel} · ${modelName}`;
}

function main() {
  const { out, sources } = parseArgs(process.argv.slice(2));
  const seen = new Set();
  const models = [];
  const perProvider = [];

  let priority = 1;
  for (const { provider, file } of sources) {
    const catalog = loadCatalog(file);
    let added = 0;
    let skipped = 0;
    for (const model of catalog) {
      if (typeof model.slug !== "string" || model.slug.length === 0) {
        skipped += 1;
        continue;
      }
      const slug = mergeSlug(provider, model.slug);
      if (seen.has(slug)) {
        skipped += 1;
        continue;
      }
      seen.add(slug);
      models.push({
        ...buildTemplate(model),
        slug,
        display_name: mergedDisplayName(provider, model.display_name, model.slug),
        priority: priority++,
      });
      added += 1;
    }
    perProvider.push({ provider, file, added, skipped });
  }

  const payload = { models };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  for (const entry of perProvider) {
    console.log(`${entry.provider}: +${entry.added} (skipped ${entry.skipped}) <- ${entry.file}`);
  }
  console.log(`merged: ${models.length} models -> ${out}`);
}

main();
