import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "./auth.js";

function legacyHash(password: string) {
  const salt = "legacy-salt";
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

test("modern password hashes validate and do not need rehashing", () => {
  const hash = hashPassword("strong-password-1");
  assert.equal(verifyPassword("strong-password-1", hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
  assert.equal(passwordNeedsRehash(hash), false);
});

test("legacy password hashes still validate and are marked for rehashing", () => {
  const hash = legacyHash("old-password");
  assert.equal(verifyPassword("old-password", hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
  assert.equal(passwordNeedsRehash(hash), true);
});
