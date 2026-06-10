import assert from "node:assert/strict";
import test from "node:test";
import { telegramWebhookAuthorizationStatus } from "./telegram-webhook.js";

test("telegram webhook treats missing or weak secret as unconfigured", () => {
  assert.equal(telegramWebhookAuthorizationStatus({ secret: "" }), "unconfigured");
  assert.equal(telegramWebhookAuthorizationStatus({ secret: "short" }), "unconfigured");
  assert.equal(telegramWebhookAuthorizationStatus({ secret: undefined, headerToken: "anything" }), "unconfigured");
});

test("telegram webhook authorizes only on exact header match", () => {
  const secret = "abcdef0123456789secret";
  assert.equal(telegramWebhookAuthorizationStatus({ secret, headerToken: secret }), "authorized");
  assert.equal(telegramWebhookAuthorizationStatus({ secret, headerToken: "wrong" }), "unauthorized");
  assert.equal(telegramWebhookAuthorizationStatus({ secret, headerToken: undefined }), "unauthorized");
});
