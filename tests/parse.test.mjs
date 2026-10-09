import test from "node:test";
import assert from "node:assert/strict";
import { parseSoulseekMetadata, rankTracks, fallbackQueries, describeFile } from "../src/audio.js";

test("numbered file in album folder", () => {
  const m = parseSoulseekMetadata("Dhurandhar (2025)/03 - Title Track.mp3");
  assert.equal(m.title, "Title Track");
  assert.equal(m.album, "Dhurandhar");
});

test("Artist/Album/numbered-title layout", () => {
  const m = parseSoulseekMetadata("Music\\RADWIMPS\\Weathering With You\\03 Grand Escape (feat. Toko Miura).flac");
  assert.equal(m.artist, "RADWIMPS");
  assert.equal(m.album, "Weathering With You");
  assert.equal(m.title, "Grand Escape (feat. Toko Miura)");
});

test("Artist - Album parent folder", () => {
  const m = parseSoulseekMetadata("shares\\Man With A Mission\\絆ノ奇跡 + コイコガレ (2023)\\02 - Koi Kogare.flac");
  assert.equal(m.artist, "Man With A Mission");
  assert.equal(m.title, "Koi Kogare");
});

test("plain Artist - Title", () => {
  const m = parseSoulseekMetadata("Hanumankind - Naal Nachna.mp3");
  assert.equal(m.artist, "Hanumankind");
  assert.equal(m.title, "Naal Nachna");
});

test("quality tags stripped, identity kept", () => {
  const m = parseSoulseekMetadata("Artist - Song [FLAC 24-bit].flac");
  assert.equal(m.title, "Song");
});

test("ranking puts exact recording first", () => {
  const tracks = [
    { id: "a", title: "Naal Nachna", artist: "Hanumankind", album: "Dhurandhar" },
    { id: "b", title: "Title Track", artist: "Hanumankind", album: "Dhurandhar" },
  ];
  const ranked = rankTracks("Dhurandhar Title Track", tracks);
  assert.equal(ranked[0].id, "b");
});

test("fallback queries split parentheticals", () => {
  const alts = fallbackQueries("Suzume (ft. Toaka)");
  assert.ok(alts.includes("Suzume"));
});

test("bitrate derived from size+duration, strict tiers", () => {
  // 320kbps-ish mp3: 9.6MB over 240s
  const mp3 = describeFile("a.mp3", { size: 9600000, length: 240 });
  assert.ok(mp3.bitrate >= 300000 && mp3.bitrate <= 340000);
  assert.equal(mp3.audioQuality, "HIGH");
  // 128kbps mp3
  const low = describeFile("b.mp3", { size: 3840000, length: 240 });
  assert.equal(low.audioQuality, "LOW");
  // flac is always LOSSLESS
  assert.equal(describeFile("c.flac", {}).audioQuality, "LOSSLESS");
  // unknown lossy never overclaims
  assert.equal(describeFile("d.mp3", {}).audioQuality, "LOW");
});

test("lossless request prefers lossless within same recording", () => {
  const tracks = [
    { id: "a", title: "Song", artist: "X", audioQuality: "HIGH", _bitrate: 320000 },
    { id: "b", title: "Song", artist: "X", audioQuality: "LOSSLESS" },
  ];
  assert.equal(rankTracks("Song", tracks, "lossless")[0].id, "b");
  // ...but recording match still beats tier across recordings
  const mixed = [
    { id: "a", title: "Other Song", artist: "X", audioQuality: "LOSSLESS" },
    { id: "b", title: "My Song", artist: "X", audioQuality: "LOW", _bitrate: 128000 },
  ];
  assert.equal(rankTracks("My Song", mixed, "lossless")[0].id, "b");
});
