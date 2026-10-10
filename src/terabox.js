// TeraBox backend (via saahiyo/terabox-gateway): personal-library catalog.
//
// The gateway resolves TeraBox *share URLs* into file lists + direct download
// links. It cannot search — so this backend matches queries against a local
// catalog (built once from your share URLs, refreshed on demand) and resolves
// a FRESH direct link on every /stream (links expire; perfect fit).
//
// Credentials: the gateway itself holds your TeraBox `ndus` cookie. This addon
// only needs TERABOX_GATEWAY_URL (+ the catalog file). No TeraBox login here.

import fs from "node:fs";
import { AUDIO_EXTS, describeFile, parseSoulseekMetadata } from "./audio.js";

export function teraboxConfig() {
  return {
    gatewayUrl: (process.env.TERABOX_GATEWAY_URL ?? "").replace(/\/$/, ""),
    catalogPath: process.env.TERABOX_CATALOG ?? "./terabox.catalog.json",
  };
}

export function teraboxEnabled() {
  return Boolean(teraboxConfig().gatewayUrl);
}

// Track ids are opaque + stable: the share URL plus the file path inside it.
export function encodeTeraboxId(shareUrl, filename) {
  return Buffer.from(JSON.stringify([shareUrl, filename]), "utf8").toString("base64url");
}

export function decodeTeraboxId(id) {
  const [shareUrl, filename] = JSON.parse(Buffer.from(String(id), "base64url").toString("utf8"));
  if (!shareUrl || !filename) throw new Error("bad id");
  return { shareUrl, filename };
}

async function gatewayGet(gatewayUrl, params) {
  const url = new URL(`${gatewayUrl}/api`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`terabox-gateway ${res.status} for ${url.pathname}`);
  return res.json();
}

// Resolve one share URL into normalized audio files.
export async function resolveShare(gatewayUrl, shareUrl) {
  const data = await gatewayGet(gatewayUrl, { url: shareUrl, resolve: "true" });
  if (data?.status && data.status !== "success") {
    throw new Error(`terabox resolve failed: ${data.message ?? data.status}`);
  }
  const files = data?.files ?? [];
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const filename = f.filename ?? f.name ?? f.path ?? "";
    const dot = filename.lastIndexOf(".");
    if (dot < 0 || !AUDIO_EXTS.has(filename.slice(dot).toLowerCase())) continue;
    const link = f.download_link ?? f.downloadLink ?? f.link ?? f.url ?? null;
    out.push({ filename, size: typeof f.size === "number" ? f.size : undefined, downloadLink: link });
  }
  return out;
}

export function loadCatalog(catalogPath) {
  try {
    const raw = fs.readFileSync(catalogPath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    return entries.filter((e) => e?.shareUrl && e?.filename);
  } catch {
    return [];
  }
}

export function catalogToTracks(entries) {
  return entries.map((e) => {
    const meta = describeFile(e.filename, { size: e.size });
    const parsed = parseSoulseekMetadata(e.filename);
    return {
      id: encodeTeraboxId(e.shareUrl, e.filename),
      title: parsed.title,
      artist: parsed.artist,
      album: parsed.album,
      duration: typeof e.duration === "number" ? e.duration : undefined,
      format: meta.format,
      audioQuality: meta.audioQuality,
      _bitrate: meta.bitrate,
      _shareUrl: e.shareUrl,
      _filename: e.filename,
    };
  });
}

export async function searchTerabox(query) {
  const { gatewayUrl, catalogPath } = teraboxConfig();
  if (!gatewayUrl) throw new Error("TERABOX_GATEWAY_URL not set");
  // NOTE: the gateway has no search endpoint — matching happens over the
  // local catalog. Rebuild it when your library changes (see scripts/).
  return catalogToTracks(loadCatalog(catalogPath));
}

// Resolve a FRESH stream: direct links expire, so never serve a cached one.
export async function streamTerabox(id) {
  const { gatewayUrl } = teraboxConfig();
  if (!gatewayUrl) throw new Error("TERABOX_GATEWAY_URL not set");
  const { shareUrl, filename } = decodeTeraboxId(id);
  const files = await resolveShare(gatewayUrl, shareUrl);
  const hit = files.find((f) => f.filename === filename)
    ?? files.find((f) => f.filename.split(/[\\/]/).pop() === filename.split(/[\\/]/).pop());
  if (!hit?.downloadLink) return null;
  const meta = describeFile(hit.filename, { size: hit.size });
  return {
    url: hit.downloadLink,
    format: meta.format,
    quality: meta.lossless ? "Lossless (TeraBox)" : meta.bitrate ? `TeraBox · ~${Math.round(meta.bitrate / 1000)} kbps` : "TeraBox",
    codec: meta.codec,
    container: meta.container,
    manifest: "none",
    encrypted: false,
    ...(meta.bitrate ? { bitrate: meta.bitrate } : {}),
  };
}
