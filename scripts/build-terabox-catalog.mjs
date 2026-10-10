#!/usr/bin/env node
// Build the TeraBox catalog: resolve share URLs into a local match index.
// Usage:
//   node scripts/build-terabox-catalog.mjs https://teraboxshare.com/s/XXXX ...
//   TERABOX_SHARES="url1,url2" TERABOX_CATALOG=./terabox.catalog.json node scripts/build-terabox-catalog.mjs
// The gateway holds your TeraBox ndus cookie; this script only needs
// TERABOX_GATEWAY_URL. Re-run whenever your library changes.

import fs from "node:fs";
import { teraboxConfig, resolveShare } from "../src/terabox.js";

const { gatewayUrl, catalogPath } = teraboxConfig();
if (!gatewayUrl) {
  console.error("TERABOX_GATEWAY_URL not set");
  process.exit(1);
}

const fromEnv = (process.env.TERABOX_SHARES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const urls = [...process.argv.slice(2), ...fromEnv];
if (!urls.length) {
  console.error("no share URLs given (args or TERABOX_SHARES)");
  process.exit(1);
}

const entries = [];
for (const shareUrl of new Set(urls)) {
  try {
    const files = await resolveShare(gatewayUrl, shareUrl);
    for (const f of files) entries.push({ shareUrl, filename: f.filename, size: f.size });
    console.error(`ok: ${shareUrl} -> ${files.length} audio files`);
  } catch (err) {
    console.error(`FAIL: ${shareUrl}: ${err.message}`);
  }
}

fs.writeFileSync(catalogPath, JSON.stringify({ builtAt: new Date().toISOString(), entries }, null, 1));
console.error(`wrote ${entries.length} entries -> ${catalogPath}`);
