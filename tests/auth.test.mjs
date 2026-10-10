import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.ADDON_TOKEN = "s3cr3t-token";

const { createServer } = await import("../src/server.js");
const { config } = await import("../src/config.js");
assert.equal(config.ADDON_TOKEN, "s3cr3t-token");

const srv = createServer();
await new Promise((r) => srv.listen(0, r));
after(() => srv.close());
const base = `http://localhost:${srv.address().port}`;
const P = `/s3cr3t-token`;

test("manifest lives under the token prefix", async () => {
  const bare = await fetch(`${base}/manifest.json`);
  assert.equal(bare.status, 401);
  const body = await (await fetch(`${base}${P}/manifest.json`)).json();
  assert.ok(body.id);
  const setting = body.settings.find((s) => s.key === "token");
  assert.ok(setting);
  assert.equal(setting.default, "s3cr3t-token");
});

test("search/stream/media require the prefixed path", async () => {
  assert.equal((await fetch(`${base}/search?q=x`)).status, 401);
  assert.equal((await fetch(`${base}/stream/abc`)).status, 401);
  assert.equal((await fetch(`${base}/media/abc`)).status, 401);
  assert.equal((await fetch(`${base}/nope`)).status, 401);
});

test("prefixed routes work with query token", async () => {
  // Repo .env may point at real backends; accept 200 or 404, never 401.
  for (const p of [`${P}/search?q=x&token=s3cr3t-token`, `${P}/stream/mock_midnight_signal?token=s3cr3t-token`]) {
    const status = (await fetch(`${base}${p}`)).status;
    assert.ok([200, 404].includes(status), `${p} -> ${status}`);
  }
});

test("health stays open for ops", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("wrong token rejected everywhere", async () => {
  assert.equal((await fetch(`${base}/wrong/search?q=x`)).status, 401);
  assert.equal((await fetch(`${base}${P}/search?q=x&token=wrong`)).status, 401);
});
