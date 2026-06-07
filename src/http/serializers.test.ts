import assert from "node:assert/strict";
import test from "node:test";
import type { UserDocument } from "../models.js";
import { memberUser, publicUser, userForViewer } from "./serializers.js";

function user(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-1",
    name: "Alua",
    email: "alua@example.com",
    role: "intern",
    category: "data-security",
    avatarColor: "#10765a",
    avatarUrl: "",
    bio: "",
    firstLoginCompleted: true,
    emailVerified: true,
    telegramChatId: "chat-1",
    telegramUserId: "777",
    telegramUsername: "alua_dev",
    telegramActivityMessages: 12,
    telegramActivityScore: 55,
    telegramActivitySummary: "active",
    registrationSource: "web",
    registrationReferrer: "https://t.me/source",
    registrationUtmSource: "telegram",
    registrationUtmMedium: "",
    registrationUtmCampaign: "",
    registrationSocialSource: "telegram",
    lastActiveAt: new Date("2026-06-07T05:00:00.000Z"),
    createdAt: new Date("2026-06-01T05:00:00.000Z"),
    updatedAt: new Date("2026-06-02T05:00:00.000Z"),
    ...overrides
  } as unknown as UserDocument;
}

test("memberUser omits private contact and Telegram identifiers", () => {
  const serialized = memberUser(user());
  assert.equal(serialized.name, "Alua");
  assert.equal("email" in serialized, false);
  assert.equal("telegramUserId" in serialized, false);
  assert.equal("telegramUsername" in serialized, false);
});

test("userForViewer shows full fields only to leads, admins, and the user themself", () => {
  const subject = user();
  const otherInternView = userForViewer(subject, { id: "other-user", role: "intern" });
  const leadView = userForViewer(subject, { id: "lead-1", role: "lead" });
  const selfView = userForViewer(subject, { id: "user-1", role: "intern" });

  assert.equal("email" in otherInternView, false);
  assert.equal(publicUser(subject).email, "alua@example.com");
  assert.equal("email" in leadView, true);
  assert.equal("email" in selfView, true);
});
