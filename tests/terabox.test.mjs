import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  encodeTeraboxId,
  decodeTeraboxId,
  resolveShare,
  loadCatalog,
  catalogToTracks,
  streamTerabox,
} from "../src/terabox.js";
import { rankTracks } from "../src/audio.js";

// Stub terabox-gateway: canned /api responses, no network needed.
const SHARE = "https://teraboxshare.com/s/abc123";
const FILES = [
  { filename: "RADWIMPS - Suzume (feat. Toaka).flac", size: 53670639, download_link: "https://dl.example/t1.flac" },
  { filename: "RADWIMPS - Grand Escape.mp3", size: 9600000, download_link: "https://dl.example/t2.mp3" },
  { filename: "cover.jpg", size: 12345, download_link: "https://dl.example/c.jpg" },
];

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api" && url.searchParams.get("url") === SHARE) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "success", files: FILES }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "error", message: "not found" }));
});
await new Promise((r) => srv.listen(0, r));
after(() => srv.close());
const GW = `http://localhost:${srv.address().port}`;

test("id roundtrip", () => {
  const id = encodeTeraboxId(SHARE, FILES[0].filename);
  assert.deepEqual(decodeTeraboxId(id), { shareUrl: SHARE, filename: FILES[0].filename });
});

test("resolve lists audio only", async () => {
  const files = await resolveShare(GW, SHARE);
  assert.equal(files.length, 2);
  assert.equal(files[0].downloadLink, "https://dl.example/t1.flac");
});

test("catalog search ranks exact recording first", () => {
  const tracks = rankTracks(
    "suzume",
    catalogToTracks([
      { shareUrl: SHARE, filename: FILES[1].filename, size: FILES[1].size },
      { shareUrl: SHARE, filename: FILES[0].filename, size: FILES[0].size },
    ])
  );
  assert.match(tracks[0].title.toLowerCase(), /suzume/);
  assert.equal(tracks[0].audioQuality, "LOSSLESS");
});

test("stream resolves a fresh direct link", async () => {
  process.env.TERABOX_GATEWAY_URL = GW;
  const id = encodeTeraboxId(SHARE, FILES[0].filename);
  const body = await streamTerabox(id);
  assert.equal(body.url, "https://dl.example/t1.flac");
  assert.equal(body.codec, "flac");
  assert.equal(body.encrypted, false);
  delete process.env.TERABOX_GATEWAY_URL;
});

test("stream 404s on unknown share (null)", async () => {
  process.env.TERABOX_GATEWAY_URL = GW;
  const id = encodeTeraboxId("https://terabox.com/s/nope", "x.flac");
  const body = await streamTerabox(id).catch(() => null);
  assert.equal(body, null);
  delete process.env.TERABOX_GATEWAY_URL;
});

test("loadCatalog tolerates missing file", () => {
  assert.deepEqual(loadCatalog("/tmp/does-not-exist-terabox.json"), []);
});
