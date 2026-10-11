import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const GATE = new URL("../deploy/share-gate.sh", import.meta.url).pathname;

function runGate(env) {
  execFileSync(GATE, {
    env: { ...process.env, PATH: "/usr/bin:/bin", ...env },
    timeout: 30000,
  });
}

test("moves idle files, keeps fresh ones, skips incomplete", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const staging = path.join(base, "staging");
  const shared = path.join(base, "shared");
  fs.mkdirSync(path.join(staging, "incomplete"), { recursive: true });
  const oldie = path.join(staging, "old.flac");
  const fresh = path.join(staging, "new.flac");
  const partial = path.join(staging, "incomplete", "part.flac");
  fs.writeFileSync(oldie, "x".repeat(100));
  fs.writeFileSync(fresh, "y".repeat(100));
  fs.writeFileSync(partial, "z".repeat(100));
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(oldie, twoHoursAgo, twoHoursAgo);

  runGate({
    STAGING_DIR: staging,
    SHARED_DIR: shared,
    SHARE_DELAY_HOURS: "0",
    TERABOX_ENABLED: "1",
  });

  assert.ok(fs.existsSync(path.join(shared, "old.flac")), "idle file promoted");
  assert.ok(fs.existsSync(fresh), "fresh file stays");
  assert.ok(fs.existsSync(partial), "incomplete never moves");
  fs.rmSync(base, { recursive: true, force: true });
});

test("parks when TeraBox tier disabled with terabox destination", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const staging = path.join(base, "staging");
  fs.mkdirSync(staging, { recursive: true });
  const f = path.join(staging, "a.flac");
  fs.writeFileSync(f, "x".repeat(10));
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(f, twoHoursAgo, twoHoursAgo);

  runGate({
    STAGING_DIR: staging,
    SHARED_DIR: "/terabox/soulseek",
    TERABOX_ENABLED: "0",
  });

  assert.ok(fs.existsSync(f), "nothing moved while parked");
  fs.rmSync(base, { recursive: true, force: true });
});
