import fs from "node:fs";
import { encodeId, describeFile, parseSoulseekMetadata, AUDIO_EXTS } from "./audio.js";
import { config, webdavEnabled } from "./config.js";

// Local index of the read-only library mount (built by
// scripts/build-hifi-index.mjs): [{ path, size }] with paths relative to
// the mount root. Small file, read per search — cheap.
function loadHifiIndex() {
  const p = process.env.HIFI_INDEX ?? "./hifi.index.json";
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    return entries.filter((e) => e?.path);
  } catch {
    return [];
  }
}

// Tracks from the library mount. Ids reuse the soulseek shape with a
// reserved "hifi" username so the whole stream/media path works unchanged:
// enqueue fails (caught), waitForFile finds by basename, serve is local-read.
export function hifiTracks() {
  if (!config.WEBDAV_DIR || !webdavEnabled()) return [];
  return loadHifiIndex()
    .filter((e) => {
      const dot = e.path.lastIndexOf(".");
      return dot >= 0 && AUDIO_EXTS.has(e.path.slice(dot).toLowerCase());
    })
    .map((e) => {
    const meta = describeFile(e.path, { size: e.size });
    // Library mounts are usually organized Artist/... — a lone folder names
    // the artist, not the album.
    const parsed = parseSoulseekMetadata(e.path, { singleDirMeans: "artist" });
    return {
      id: encodeId("hifi", e.path),
      title: parsed.title,
      artist: parsed.artist,
      album: parsed.album,
      duration: undefined,
      format: meta.format,
      audioQuality: meta.audioQuality,
      _source: "hifi",
      _size: e.size,
      _bitrate: meta.bitrate,
      _codec: meta.codec,
      _username: "hifi",
      _filename: e.path,
    };
  });
}
