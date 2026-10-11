#!/usr/bin/env node
// Index a local directory tree (e.g. the /hifi rclone mount) into a JSON
// catalog the addon searches alongside SoulSeek. Run on a schedule; the
// addon reads the file per search (small = fast).
// Usage: HIFI_INDEX=/tmp/hifi.json node scripts/build-hifi-index.mjs /hifi
import fs from "node:fs";
import path from "node:path";

const AUDIO = new Set([".flac", ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".wav", ".aiff", ".alac", ".wma"]);

const root = process.argv[2] ?? "/hifi";
const outPath = process.env.HIFI_INDEX ?? "./hifi.index.json";
const entries = [];

function walk(dir, rel) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of list) {
    const full = path.join(dir, e.name);
    const rp = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rp);
    else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (!AUDIO.has(e.name.slice(dot).toLowerCase())) continue;
      let size;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size > 0) entries.push({ path: rp, size });
    }
  }
}

walk(root, "");
fs.writeFileSync(outPath, JSON.stringify({ builtAt: new Date().toISOString(), entries }));
console.error(`indexed ${entries.length} audio files -> ${outPath}`);
