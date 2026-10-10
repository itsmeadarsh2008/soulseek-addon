import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.ADDON_TOKEN = "s3cr3t-token";

const { createServer, checkToken } = await import("../src/server.js");
const { config } = await import("../src/config.js");
assert.equal(config.ADDON_TOKEN, "s3cr3t-token");

const srv = createServer();
await new Promise((r) => srv.listen(0, r));
after(() => srv.close());
const base = `http://localhost:${srv.address().port}`;

test("manifest advertises the token setting", async () => {
  const body = await (await fetch(`${base}/manifest.json`)).json();
  const setting = body.settings.find((s) => s.key === "token");
  assert.ok(setting);
  assert.equal(setting.default, "s3cr3t-token");
});

test("search/stream/media require the token", async () => {
  assert.equal((await fetch(`${base}/search?q=x`)).status, 401);
  assert.equal((await fetch(`${base}/stream/abc`)).status, 401);
  assert.equal((await fetch(`${base}/media/abc`)).status, 401);
});

test("correct token passes (mock backend)", async () => {
  // No SLSKD/TERABOX in this process env... but repo .env may set them.
  // Either way: authenticated requests must not 401.
  const withToken = (p) => `${p}${p.includes("?") ? "&" : "?"}token=s3cr3t-token`;
  for (const p of ["/search?q=x", "/stream/mock_midnight_signal"]) {
    const status = (await fetch(`${base}${withToken(p)}`)).status;
    assert.ok([200, 404].includes(status), `${p} -> ${status}`);
    assert.notEqual(status, 401);
  }
});

test("wrong token rejected, open mode without token", async () => {
  const bad = await fetch(`${base}/search?q=x&token=wrong`);
  assert.equal(bad.status, 401);
  config.ADDON_TOKEN = "";
  try {
    assert.equal((await fetch(`${base}/search?q=x`)).status, 200);
  } finally {
    config.ADDON_TOKEN = "s3cr3t-token";
  }
});
