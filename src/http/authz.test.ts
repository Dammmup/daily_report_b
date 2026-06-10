import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Response } from "express";
import { requireRole, type AuthedRequest } from "./middleware/auth.js";
import { userForViewer } from "./serializers.js";

function runGuard(role: "intern" | "lead" | "admin" | undefined, allowed: ("intern" | "lead" | "admin")[]) {
  let status = 0;
  let nextCalled = false;
  const req = { user: role ? { role } : undefined } as unknown as AuthedRequest;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    }
  } as unknown as Response;
  requireRole(...allowed)(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);
  return { status, nextCalled };
}

test("requireRole lets allowed roles through and blocks others with 403", () => {
  assert.deepEqual(runGuard("admin", ["admin"]), { status: 0, nextCalled: true });
  assert.deepEqual(runGuard("lead", ["lead", "admin"]), { status: 0, nextCalled: true });
  // intern hitting a lead-only route
  assert.deepEqual(runGuard("intern", ["lead", "admin"]), { status: 403, nextCalled: false });
  // lead hitting an admin-only route
  assert.deepEqual(runGuard("lead", ["admin"]), { status: 403, nextCalled: false });
  // missing user (defensive)
  assert.deepEqual(runGuard(undefined, ["admin"]), { status: 403, nextCalled: false });
});

test("userForViewer hides private fields from non-owner interns and exposes them to leads/admins/self", () => {
  const target = {
    id: "user-1",
    name: "Иван",
    role: "intern",
    category: "sales",
    avatarColor: "#fff",
    avatarUrl: "",
    email: "ivan@x.io",
    bio: "",
    firstLoginCompleted: true,
    emailVerified: true,
    telegramChatId: "",
    telegramDigestEnabled: false,
    telegramDigestTime: "18:00",
    telegramDigestContent: "full",
    telegramActivityMessages: 0,
    telegramActivityScore: 0,
    telegramActivitySummary: "",
    lastActiveAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  } as never;

  // Чужой стажёр видит только публичную карточку без email.
  const asOtherIntern = userForViewer(target, { id: "user-2", role: "intern" }) as Record<string, unknown>;
  assert.equal("email" in asOtherIntern, false);

  // Лид видит расширенную информацию (email присутствует).
  const asLead = userForViewer(target, { id: "user-2", role: "lead" }) as Record<string, unknown>;
  assert.equal(asLead.email, "ivan@x.io");

  // Сам пользователь тоже видит полную карточку.
  const asSelf = userForViewer(target, { id: "user-1", role: "intern" }) as Record<string, unknown>;
  assert.equal(asSelf.email, "ivan@x.io");
});
