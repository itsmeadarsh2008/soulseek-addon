// Audio helpers: map a SoulSeek filename to honest BitChord codec metadata.
// Never overstate: unknown bitrate stays unknown, lossy stays lossy.

const EXT_MAP = {
  ".flac": { codec: "flac", container: "flac", format: "flac", lossless: true },
  ".wav": { codec: "pcm", container: "wav", format: "wav", lossless: true },
  ".aiff": { codec: "pcm", container: "aiff", format: "aiff", lossless: true },
  ".alac": { codec: "alac", container: "m4a", format: "alac", lossless: true },
  ".m4a": { codec: "aac", container: "mp4", format: "aac", lossless: false },
  ".mp3": { codec: "mp3", container: "mp3", format: "mp3", lossless: false },
  ".ogg": { codec: "vorbis", container: "ogg", format: "ogg", lossless: false },
  ".oga": { codec: "vorbis", container: "ogg", format: "ogg", lossless: false },
  ".opus": { codec: "opus", container: "ogg", format: "opus", lossless: false },
  ".wma": { codec: "wma", container: "asf", format: "wma", lossless: false },
};

export const AUDIO_EXTS = new Set(Object.keys(EXT_MAP));

export function describeFile(filename, { bitrate, sampleRate, bitDepth, size, length } = {}) {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  const known = EXT_MAP[ext] ?? { codec: ext.replace(".", "") || "unknown", container: "unknown", format: "unknown", lossless: false };
  // Normalize slskd bitrate (may be kbps or bps depending on version).
  let bps;
  if (typeof bitrate === "number" && Number.isFinite(bitrate)) {
    bps = bitrate < 1000 ? Math.round(bitrate * 1000) : Math.round(bitrate);
  } else if (typeof size === "number" && size > 0 && typeof length === "number" && length > 0) {
    // slskd search responses carry size+length but no bitrate — derive it.
    bps = Math.round((size * 8) / length);
  }
  // Strict BitChord tiers: only labels the player itself recognizes can win
  // quality upgrades. Unknown bitrate stays LOW (conservative, never overclaim).
  const audioQuality = known.lossless ? "LOSSLESS" : bps >= 256000 ? "HIGH" : "LOW";
  return {
    ext,
    codec: known.codec,
    container: known.container,
    format: known.format,
    lossless: known.lossless,
    bitrate: bps,
    sampleRate: typeof sampleRate === "number" ? sampleRate : undefined,
    bitDepth: typeof bitDepth === "number" ? bitDepth : undefined,
    audioQuality,
  };
}

// Read duration/fidelity from the first bytes of an audio file (no decode).
// Returns { duration, sampleRate, bitDepth } or {} when unknown.
// FLAC: STREAMINFO block. MP3: Xing/Info header. Others: unknown.
export function probeAudioHeader(buf, ext) {
  try {
    if (ext === ".flac" && buf.subarray(0, 4).toString() === "fLaC") {
      let off = 4;
      for (let guard = 0; guard < 8; guard++) {
        const type = buf[off] & 0x7f;
        const len = buf.readUIntBE(off + 1, 3);
        const last = buf[off] & 0x80;
        off += 4;
        if (type === 0 && len >= 18 && off + 18 <= buf.length) {
          const sr = (buf.readUIntBE(off + 10, 3) >>> 4) & 0xfffff;
          const bd = (((buf[off + 12] & 1) << 4) | (buf[off + 13] >>> 4)) + 1;
          const hi = buf[off + 13] & 0x0f;
          const lo = buf.readUIntBE(off + 14, 4);
          const total = hi * 0x100000000 + lo;
          if (sr > 0 && total > 0) {
            return { duration: Math.round(total / sr), sampleRate: sr, bitDepth: bd === 32 ? undefined : bd };
          }
        }
        off += len;
        if (last || off >= buf.length) break;
      }
    }
    if (ext === ".mp3") {
      const tag = buf.indexOf("Xing") >= 0 ? "Xing" : buf.indexOf("Info") >= 0 ? "Info" : null;
      if (tag) {
        const o = buf.indexOf(tag);
        const frames = buf.readUInt32BE(o + 8);
        const v = (buf[2] >>> 3) & 0x03;
        const layer = (buf[1] >>> 1) & 0x03;
        const spf = v === 3 ? (layer === 3 ? 576 : 1152) : layer === 3 ? 576 : layer === 2 ? 1152 : 384;
        const srTable = [44100, 48000, 32000];
        const sr = srTable[(buf[2] >>> 2) & 0x03] ?? 44100;
        if (frames > 0 && spf > 0) return { duration: Math.round((frames * spf) / sr) };
      }
    }
  } catch { /* unknown */ }
  return {};
}

// Track ids must be opaque + stable + URL-safe. SoulSeek identity is (username, filename).
export function encodeId(username, filename) {
  return Buffer.from(JSON.stringify([username, filename]), "utf8").toString("base64url");
}

export function decodeId(id) {
  const [username, filename] = JSON.parse(Buffer.from(String(id), "base64url").toString("utf8"));
  if (!username || !filename) throw new Error("bad id");
  return { username, filename };
}

// "Artist - Title.mp3" or "Artist/Album/01 Title.flac" -> best-effort metadata.
// SoulSeek filenames are messy (track numbers, folders, quality tags), so this
// parses the full path, not just the basename. Accurate artist/album/duration
// is what lets BitChord pick the RIGHT recording (Title Track, not Naal Nachna).
export function guessMetadata(filename) {
  return parseSoulseekMetadata(filename);
}

const GENERIC_DIRS = new Set([
  "music", "my music", "shares", "shared", "share", "downloads", "soulseek downloads",
  "audio", "songs", "tracks", "lossless", "flac", "mp3", "mp3s", "320kbps", "320",
  "albums", "album", "singles", "single", "eps", "ep", "discography",
  "soundtrack", "soundtracks", "ost", "anime", "hindi", "punjabi", "tamil",
  "telugu", "english", "bollywood", "kpop", "jpop", "j-pop", "music videos",
]);
const QUALITY_TOKENS = /^(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff|alac|wma|320|256|192|128|v0|vinyl|web|cd|single|album|ep|lossless|hi-?res|24bit|24-96|16bit|320kbps|128kbps|cbr|vbr)$/i;

export function cleanToken(s) {
  return s
    .replace(/_/g, " ") // benny_bridges-the_grand_escape -> spaced words
    .replace(/\s{2,}/g, " ")
    .replace(/^\[[\d.\s\-_]+\]\s*/, "") // leading "[2023.05.31]" dates
    .replace(/\s*\(\d{4}\)\s*$/, "") // trailing "(2025)" year
    .replace(/\s*\[[\d.\s\-_]+\]\s*$/, "") // trailing "[2021]" year
    .trim();
}

function stripQualityTags(s) {
  // Remove bracketed codec/bitrate tags but KEEP recording identity:
  // (feat. X), (Movie Edit), [TV Version] all stay.
  return s
    .split(/\s+/)
    .filter((w) => !/^(?:flac|mp3|m4a|aac|ogg|opus|wav|alac|wma|320|256|192|128|v0|vinyl|web|cd|lossless|hi-?res|24-?bit|16-?bit|cbr|vbr|\d{2,4}k?b?ps?)$/i.test(w.replace(/[()\[\]{}]/g, "")) || /feat/i.test(w))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim() || s.trim();
}

function isGenericDir(name) {
  const n = name.replace(/^@@/, "").trim().toLowerCase();
  return !n || n.startsWith("@@") || GENERIC_DIRS.has(n) || /^disc\s*\d+$/.test(n) || /^(cd|dvd)\d*$/i.test(n);
}

function stripTrackNo(s) {
  // Leading track numbers only in unambiguous forms, applied until stable:
  // "02.08 - X", "01-02 X" (compound), "03. X", "1- X" (dash/dot),
  // "01 X" (leading zero). Bare "22 X" / "7 Years" / "1975" are left intact —
  // they may be the actual title.
  let t = s;
  for (;;) {
    const n = t
      .replace(/^\s*\d{1,3}[.-]\d{1,3}\s*[-.]?\s*/, "")
      .replace(/^\s*\d{1,3}[.-]\s*/, "")
      .replace(/^\s*0\d\s+/, "");
    if (n === t) return t;
    t = n;
  }
}

export function splitArtistTitle(base) {
  // "Artist - Title" but NOT "01 - Title" (track number, not artist).
  const m = base.match(/^\s*(.+?)\s*-\s*(.+?)\s*$/);
  if (m) {
    const artist = stripTrackNo(m[1]).trim();
    const title = stripTrackNo(m[2]).replace(/^\s*-\s*/, "").trim();
    if (artist && !/^\d+([.-]\d+)*$/.test(artist)) return [artist, title || m[2].trim()];
  }
  // No usable artist half: title is the base minus any track number.
  const t = stripTrackNo(base).replace(/^\s*-\s*/, "").trim();
  return [null, t || base.trim()];
}

export function parseSoulseekMetadata(filename, { singleDirMeans = "album" } = {}) {
  const segs = filename.split(/[\\/]/);
  const rawBase = segs.pop().replace(/\.[^.]+$/, "");
  const dirs = segs.map((d) => d.trim()).filter(Boolean);

  let artist = null;
  let title = rawBase.trim();
  let album = null;

  const [dashArtist, dashTitle] = splitArtistTitle(rawBase);
  if (dashArtist) {
    artist = stripQualityTags(cleanToken(dashArtist));
    title = stripQualityTags(dashTitle);
  } else {
    title = stripQualityTags(dashTitle);
  }

  const parent = dirs.length ? cleanToken(dirs[dirs.length - 1]) : "";
  const grandparent = dirs.length > 1 ? cleanToken(dirs[dirs.length - 2]) : "";

  if (!artist) {
    // "Artist - Album" parent folder is the most reliable signal.
    const pm = parent.match(/^\s*(.+?)\s*-\s*(.+?)\s*$/);
    if (pm && !/^\d{1,3}$/.test(pm[1].trim()) && !isGenericDir(pm[1])) {
      artist = stripQualityTags(pm[1]);
      album = stripQualityTags(pm[2]);
    } else if (!isGenericDir(parent)) {
      if (/various artists/i.test(parent)) {
        artist = "Various Artists";
      } else if (grandparent && !isGenericDir(grandparent)) {
        // Artist/Album/Title folder layout.
        artist = grandparent;
        album = parent;
      } else if (singleDirMeans === "artist") {
        // Curated library layout (Artist/Title): the lone folder is the artist.
        artist = parent;
      } else {
        // Single folder: most likely the album ("Dhurandhar (2025)").
        album = parent;
      }
    } else if (grandparent && !isGenericDir(grandparent)) {
      artist = grandparent;
    }
  } else if (parent && !isGenericDir(parent) && !/^\d{1,3}$/.test(parent)) {
    album = parent;
  }

  return {
    artist: artist || "Unknown Artist",
    title: title || rawBase.trim(),
    album: album || undefined,
  };
}

// Rank tracks against the listener's query so the exact recording surfaces
// first — BitChord evaluates matches in the order we return.
function tokens(s) {
  return s
    .toLowerCase()
    .replace(/\bft\b\.?/g, "feat")
    .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF\u3040-\u30FF\u4E00-\u9FFF ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

// Fidelity rank: hi-res lossless > lossless (ALAC over FLAC at equal depth)
// > HIGH by bitrate > LOW. ALAC and FLAC are bit-identical at the same depth,
// so depth still outranks container — ALAC wins ties.
function qualityRank(t) {
  const bps = typeof t._bitrate === "number" ? t._bitrate : 0;
  const codec = (t._codec || "").toLowerCase();
  if (t.audioQuality === "LOSSLESS") {
    let r = 4;
    if (t._bitDepth > 16) r += 1;
    if (codec === "alac") r += 0.5;
    return r;
  }
  if (t.audioQuality === "HIGH") return 3 + Math.min(0.99, bps / 1e6);
  return 2 + Math.min(0.99, bps / 1e6);
}

function matchScore(qset, q, title, artist, album) {
  const tt = tokens(title ?? "");
  const at = tokens(artist ?? "");
  const al = tokens(album ?? "");
  let s = 0;
  for (const w of new Set(tt)) if (qset.has(w)) s += 2;
  if (q.length && q.every((w) => tt.includes(w))) s += 6; // full title coverage
  for (const w of new Set(at)) if (qset.has(w)) s += 2;
  for (const w of new Set(al)) if (qset.has(w)) s += 1;
  // Positional: queries are usually "title … artist" — a title holding the
  // query's opening words outranks one holding its tail. This is what breaks
  // ties between "Shape of You / Ed Sheeran" and its swapped twin.
  if (q.length && tt.includes(q[0])) s += 4;
  return { s, full: q.length > 0 && q.every((w) => tt.includes(w)) };
}

export function rankTracks(query, tracks, quality = "") {
  const q = tokens(query);
  if (!q.length) return tracks;
  const qset = new Set(q);
  const lowFirst = quality.toLowerCase() === "low";
  const scored = tracks.map((t, i) => {
    // Peers misname files constantly ("Title - Artist"). Score both
    // orientations; adopt the swapped fields when it clearly wins so
    // BitChord receives correct metadata, not just a better order.
    const normal = matchScore(qset, q, t.title, t.artist, t.album);
    const flipped = matchScore(qset, q, t.artist, t.title, t.album);
    const useFlipped = flipped.s > normal.s + 2;
    const base = useFlipped ? flipped : normal;
    const t2 = useFlipped ? { ...t, title: t.artist, artist: t.title } : t;
    // Order: exact recording, then fidelity (reversed for low requests),
    // then partial match, then peer speed (stable input order).
    return { t: t2, full: base.full, qr: qualityRank(t), s: base.s, i };
  });
  scored.sort((a, b) =>
    (b.full - a.full) ||
    (lowFirst ? a.qr - b.qr : b.qr - a.qr) ||
    (b.s - a.s) ||
    (a.i - b.i)
  );
  return scored.map((x) => x.t);
}

// When the full query scores nothing on the distributed network, retry with
// distinctive words ("Suzume (ft. Toaka)" -> "Suzume"). Capped: each retry
// costs seconds on P2P.
export function fallbackQueries(query) {
  const words = [...new Set(tokens(query).filter((w) => w.length >= 4 && w !== "feat"))];
  const deparened = query.replace(/\s*[\(\[].*?[\)\]]\s*/g, " ").trim();
  const alts = [];
  if (deparened && deparened.toLowerCase() !== query.toLowerCase()) alts.push(deparened);
  // Longest (most distinctive) words first, max 2 extra searches.
  words.sort((a, b) => b.length - a.length);
  for (const w of words.slice(0, 2)) if (!alts.includes(w)) alts.push(w);
  return alts.filter((a) => a.toLowerCase() !== query.toLowerCase()).slice(0, 2);
}
