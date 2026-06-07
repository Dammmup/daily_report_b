import assert from "node:assert/strict";
import test from "node:test";
import { cronAuthorizationStatus } from "./cron.js";

test("cron auth rejects missing or placeholder secrets", () => {
  assert.equal(cronAuthorizationStatus({ secret: "" }), "unconfigured");
  assert.equal(cronAuthorizationStatus({ secret: "short" }), "unconfigured");
  assert.equal(cronAuthorizationStatus({ secret: "change-this-cron-secret" }), "unconfigured");
});

test("cron auth accepts bearer and x-cron-secret only when they match", () => {
  const secret = "1234567890abcdef";
  assert.equal(cronAuthorizationStatus({ secret, authorization: `Bearer ${secret}` }), "authorized");
  assert.equal(cronAuthorizationStatus({ secret, cronHeader: secret }), "authorized");
  assert.equal(cronAuthorizationStatus({ secret, authorization: "Bearer wrong" }), "unauthorized");
});
