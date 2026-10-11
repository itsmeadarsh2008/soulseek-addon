import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-idx-"));
const idx = path.join(dir, "hifi.index.json");
fs.writeFileSync(idx, JSON.stringify([
  { path: "Music/RADWIMPS/Suzume (feat. Toaka).flac", size: 53000000 },
  { path: "notes.txt", size: 10 },
]));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.HIFI_INDEX = idx;
process.env.WEBDAV_DIR = "/hifi";

const { hifiTracks } = await import("../src/hifi.js");

test("index maps to honest tracks", () => {
  const tracks = hifiTracks();
  assert.equal(tracks.length, 1);
  const [t] = tracks;
  assert.equal(t.title, "Suzume (feat. Toaka)");
  assert.equal(t.artist, "RADWIMPS");
  assert.equal(t.audioQuality, "LOSSLESS");
  assert.equal(t._source, "hifi");
  assert.ok(t.id);
});

test("ids decode to hifi user + index path", async () => {
  const { decodeId } = await import("../src/audio.js");
  const { hifiTracks: h } = await import("../src/hifi.js");
  const [t] = h();
  // soulseek-style id shape: [username, filename]
  assert.deepEqual(decodeId(t.id), {
    username: "hifi",
    filename: "Music/RADWIMPS/Suzume (feat. Toaka).flac",
  });
});

test("missing index file yields nothing", () => {
  process.env.HIFI_INDEX = "/tmp/does-not-exist-hifi.json";
  // module caches path per call (reads env live), so fresh import not needed
  return import("../src/hifi.js").then(({ hifiTracks: h3 }) => {
    assert.deepEqual(h3(), []);
    process.env.HIFI_INDEX = idx;
  });
});
