// BitChord addon server: GET /manifest.json, GET /search, GET /stream/:id, GET /media/:id.
// Zero dependencies (node:http + node:fs only). `node src/server.js` to run.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { searchMock, streamMock } from "./mock.js";
import { decodeId, describeFile, rankTracks, fallbackQueries } from "./audio.js";
import { downloadState, enqueueDownload, searchSoulseek } from "./slskd.js";
import { searchTerabox, streamTerabox } from "./terabox.js";

const searchCache = new Map(); // q -> { at, tracks } (BitChord caches ~10 min)
const streamCache = new Map(); // id -> { at, body } (BitChord caches ~5 min)
const SEARCH_TTL = 10 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;
// Prefetch circuit breaker: after any search failure, stop adding enqueue
// load for 60s so a struggling slskd can recover instead of spiraling.
let prefetchCooldownUntil = 0;

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};

function manifest() {
  const suffix = config.BACKEND === "terabox" ? " (TeraBox)"
    : config.BACKEND === "mock" ? " (mock — no backend connected)" : "";
  return {
    id: config.BACKEND === "terabox" ? "dev.terabox.addon" : config.ADDON_ID,
    name: `${config.BACKEND === "terabox" ? "TeraBox Library" : config.ADDON_NAME}${suffix}`,
    version: config.ADDON_VERSION,
    resources: ["search", "stream"],
    allowDownloads: 1,
    checkValidLossless: 0,
    settings: [{ key: "quality", type: "select", default: "lossless" }],
  };
}

async function handleSearch(url, res) {
  const q = url.searchParams.get("q") ?? "";
  const hit = searchCache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < SEARCH_TTL) return json(res, 200, { tracks: hit.tracks });

  const t0 = Date.now();
  try {
    let tracks;
    if (config.BACKEND === "mock") {
      tracks = searchMock(q);
    } else if (config.BACKEND === "terabox") {
      // Catalog match (no network search exists for TeraBox shares).
      tracks = await searchTerabox(q);
    } else {
      tracks = await searchSoulseek(q);
    }
    // Empty on P2P often means the phrasing missed, not that nothing exists —
    // retry distinctive words before giving up (capped: each costs seconds).
    // SoulSeek-only: the catalog backend has no live search to retry.
    if (config.BACKEND === "soulseek" && tracks.length === 0) {
      const seen = new Set();
      for (const alt of fallbackQueries(q)) {
        const more = await searchSoulseek(alt, { timeoutMs: 6000 }).catch(() => []);
        for (const t of more) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            tracks.push(t);
          }
        }
        if (tracks.length >= 8) break;
      }
    }
    // Exact recording first, nudged toward the requested tier: BitChord
    // evaluates recording matches in our order.
    const want = url.searchParams.get("quality") ?? "";
    tracks = rankTracks(q, tracks, want).slice(0, 20);
    // Cache hits only (full rows incl. internals for /stream fidelity lookup).
    if (tracks.length > 0) searchCache.set(q.toLowerCase(), { at: Date.now(), tracks });
    // Strip internal (_-prefixed) fields before responding.
    const pub = tracks.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("_"))));
    json(res, 200, { tracks: pub });
    console.error(`search ok: q=${JSON.stringify(q)} n=${tracks.length} ms=${Date.now() - t0}`);
    // Prefetch: BitChord usually plays one of the top hits next. Start those
    // downloads NOW in the background so /stream resolves in seconds.
    // SoulSeek-only, and skipped during the post-failure cooldown (see above).
    if (config.BACKEND === "soulseek" && Date.now() >= prefetchCooldownUntil) {
      const PREFETCH_N = Number(process.env.PREFETCH_N ?? 3);
      for (const t of tracks.slice(0, PREFETCH_N)) {
        enqueueDownload(t.id, t._size).catch(() => {});
      }
    }
  } catch (err) {
    console.error("search failed:", err.message);
    prefetchCooldownUntil = Date.now() + 60000;
    // Pass through rate-limiting so BitChord backs off instead of caching a miss.
    if (/-> 429\b/.test(err.message)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      return res.end(JSON.stringify({ tracks: [], error: "soulseek search throttled, retry shortly" }));
    }
    // Fail soft: empty results let BitChord try the next source.
    json(res, 200, { tracks: [] });
  }
}

async function handleStream(id, res) {
  const hit = streamCache.get(id);
  if (hit && Date.now() - hit.at < STREAM_TTL) return json(res, 200, hit.body);

  if (config.BACKEND === "mock") {
    const body = streamMock(id);
    if (!body) return json(res, 404, { error: "not in this addon" });
    streamCache.set(id, { at: Date.now(), body });
    return json(res, 200, body);
  }

  if (config.BACKEND === "terabox") {
    // Direct links expire: resolve fresh on every stream (fast), cache briefly.
    try {
      const body = await streamTerabox(id);
      if (!body) return json(res, 404, { error: "not in this addon" });
      streamCache.set(id, { at: Date.now(), body });
      return json(res, 200, body);
    } catch (err) {
      console.error("terabox stream failed:", err.message);
      return json(res, 404, { error: "not in this addon" });
    }
  }

  // Real mode: ask the peer to send the file, wait for first bytes on disk.
  const t0 = Date.now();
  try {
    const meta0 = findCachedMeta(id);
    // Enqueue best-effort: slskd 500s when the file is already downloaded/queued,
    // in which case we just serve what's on disk below.
    await enqueueDownload(id, meta0?.size).catch((e) => console.error("enqueue note:", e.message));
    const file = await waitForFile(id);
    if (!file) return json(res, 404, { error: "peer unavailable or queued — try next source" });
    const meta = describeFile(file.filename);
    // Bitrate the player can rank: decoded from file when known, else derived
    // from the search-reported size+duration (slskd never reports bitrate).
    const bps = meta.bitrate
      ?? (meta0?.size && meta0?.duration ? Math.round((meta0.size * 8) / meta0.duration) : undefined);
    const body = {
      url: `${config.PUBLIC_BASE_URL}/media/${encodeURIComponent(id)}`,
      format: meta.format,
      quality: meta.lossless
        ? (meta0?.bitDepth && meta0.bitDepth > 16
          ? `Lossless · Hi-Res ${meta0.bitDepth}-bit${meta0.sampleRate ? ` / ${(meta0.sampleRate / 1000).toFixed(1)} kHz` : ""} (SoulSeek)`
          : "Lossless (SoulSeek)")
        : bps ? `SoulSeek · ~${Math.round(bps / 1000)} kbps` : "SoulSeek",
      codec: meta.codec,
      container: meta.container,
      manifest: "none",
      encrypted: false,
      ...(bps ? { bitrate: bps } : {}),
      ...(meta0?.sampleRate ? { sampleRate: meta0.sampleRate } : {}),
      ...(meta0?.bitDepth ? { bitDepth: meta0.bitDepth } : {}),
    };
    streamCache.set(id, { at: Date.now(), body });
    console.error(`stream ok: ms=${Date.now() - t0}`);
    json(res, 200, body);
    // Instant TeraBox archive: mirror completed downloads straight away so
    // the cache tier doesn't wait on the hourly gate. Fire-and-forget —
    // playback already answered. Skips files already under a stable root.
    if (config.TERABOX_DIR) archiveToTerabox(file.diskPath).catch(() => {});
  } catch (err) {
    console.error("stream failed:", err.message);
    json(res, 404, { error: "not in this addon" });
  }
}

// Size + fidelity as reported by the search response, if this id came from a cached search.
function findCachedMeta(id) {
  for (const { tracks } of searchCache.values()) {
    const hit = tracks.find((t) => t.id === id);
    if (hit) {
      return {
        size: typeof hit._size === "number" ? hit._size : undefined,
        duration: typeof hit.duration === "number" ? hit.duration : undefined,
        sampleRate: typeof hit._sampleRate === "number" ? hit._sampleRate : undefined,
        bitDepth: typeof hit._bitDepth === "number" ? hit._bitDepth : undefined,
      };
    }
  }
  return {};
}

// Mirror a completed download into the TeraBox cache mount (if configured).
// Only files directly under DOWNLOAD_DIR qualify: partials (incomplete/) and
// already-stable files (shared/, terabox/) are left alone. No-clobber: a file
// already archived is never re-uploaded.
async function archiveToTerabox(diskPath) {
  const rel = path.relative(config.DOWNLOAD_DIR, diskPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const dest = path.join(config.TERABOX_DIR, "soulseek", rel);
  try {
    await fs.promises.stat(dest);
    return; // already archived
  } catch { /* missing -> copy */ }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(diskPath, dest);
}

// Poll the shared download dir until the file appears with content.
// Prefers the COMPLETE file (players choke on truncated audio); falls back
// to a partial file at timeout so BitChord can at least try the next source.
async function waitForFile(id) {
  const { filename } = decodeId(id);
  const base = filename.split(/[\\/]/).pop();
  const deadline = Date.now() + config.STREAM_WAIT_MS;
  let checks = 0;
  while (Date.now() < deadline) {
    const hit = findOnDisk(base);
    if (hit) {
      const expected = (await downloadState(id).catch(() => null))?.size;
      if (!expected || fs.statSync(hit).size >= expected) return { filename, diskPath: hit };
    } else {
      const st = await downloadState(id).catch(() => null); // keep slskd polling warm
      // Fast-fail a hopeless queue: no bytes after a few checks AND peer reports
      // a deep queue means minutes of waiting — 404 now so BitChord moves on.
      if (!hit && ++checks >= 6 && st) {
        const place = st.placeInQueue ?? st.queuePosition ?? st.queueLength ?? 0;
        if (typeof place === "number" && place > 25) return null;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const hit = findOnDisk(base);
  return hit ? { filename, diskPath: hit } : null;
}

function findOnDisk(basename) {
  const roots = [config.DOWNLOAD_DIR, config.INCOMPLETE_DIR];
  if (config.SHARED_DIR) roots.push(config.SHARED_DIR);
  if (config.TERABOX_DIR) roots.push(config.TERABOX_DIR);
  for (const root of roots) {
    const hit = walk(root, basename);
    if (hit) return hit;
  }
  return null;
}

function walk(dir, basename) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === basename && fs.statSync(p).size > 0) return p;
    if (e.isDirectory()) {
      const hit = walk(p, basename);
      if (hit) return hit;
    }
  }
  return null;
}

async function handleMedia(id, req, res) {
  if (config.MOCK_MODE) return json(res, 404, { error: "mock mode has no local media" });
  let filename;
  try {
    filename = decodeId(id).filename;
  } catch {
    return json(res, 404, { error: "bad id" });
  }
  const diskPath = findOnDisk(filename.split(/[\\/]/).pop());
  if (!diskPath) return json(res, 404, { error: "file not downloaded yet" });

  const headOnly = req.method === "HEAD";
  let stat;
  try {
    stat = fs.statSync(diskPath);
  } catch {
    return json(res, 404, { error: "file not downloaded yet" });
  }
  const cache = await mediaCacheControl(id, diskPath, stat.size);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType(diskPath),
      "Cache-Control": cache,
    });
    if (headOnly) return res.end();
    fs.createReadStream(diskPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Content-Type": contentType(diskPath),
      "Cache-Control": cache,
    });
    if (headOnly) return res.end();
    fs.createReadStream(diskPath).pipe(res);
  }
}

// Edge-cache policy (cf-edge-cache): a COMPLETE file is immutable per id, so
// CDNs may cache it long-term. A partial download must NEVER be cached —
// that would poison the edge with truncated audio.
export function cacheControlFor(diskSize, expectedSize) {
  if (typeof expectedSize === "number" && expectedSize > 0 && diskSize >= expectedSize) {
    return "public, max-age=31536000, immutable";
  }
  return "no-store";
}

function isUnderDir(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function mediaCacheControl(id, diskPath, diskSize) {
  // Completed downloads live directly under DOWNLOAD_DIR -> immutable, no
  // slskd round-trip needed on every (frequent) range request.
  if (!isUnderDir(config.INCOMPLETE_DIR, diskPath)) {
    return "public, max-age=31536000, immutable";
  }
  const expected = (await downloadState(id).catch(() => null))?.size;
  return cacheControlFor(diskSize, expected);
}

// Players sniff format by MIME first; extensionless /media/:id URLs need this.
function contentType(diskPath) {
  const ext = diskPath.slice(diskPath.lastIndexOf(".")).toLowerCase();
  if (ext === ".flac") return "audio/flac";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg" || ext === ".oga" || ext === ".opus") return "audio/ogg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/manifest.json") return json(res, 200, manifest());
    if (req.method === "GET" && url.pathname === "/search") return handleSearch(url, res);
    if (req.method === "GET" && url.pathname.startsWith("/stream/")) {
      return handleStream(decodeURIComponent(url.pathname.slice(8)), res);
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/")) {
      return handleMedia(decodeURIComponent(url.pathname.slice(7)), req, res);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, mock: config.MOCK_MODE });
    }
    return json(res, 404, { error: "not found" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(config.PORT, () => {
    console.log(`soulseek-addon on :${config.PORT} (backend=${config.BACKEND})`);
  });
}
