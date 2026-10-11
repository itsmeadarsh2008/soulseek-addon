import test from "node:test";
import assert from "node:assert/strict";
import { teraboxEnabled } from "../src/config.js";

test("enabled by default", () => {
  delete process.env.TERABOX_ENABLED;
  assert.equal(teraboxEnabled(), true);
});

test("explicit values", () => {
  process.env.TERABOX_ENABLED = "0";
  assert.equal(teraboxEnabled(), false);
  process.env.TERABOX_ENABLED = "1";
  assert.equal(teraboxEnabled(), true);
  delete process.env.TERABOX_ENABLED;
});
