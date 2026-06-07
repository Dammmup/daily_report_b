import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { configuredAllowedOrigins, isOriginAllowed } from "./app.js";
import { clearSessionCookie, setSessionCookie } from "./http/security/session-cookie.js";

test("CORS allows only configured frontend origins", () => {
  const origins = configuredAllowedOrigins();
  assert.equal(isOriginAllowed("http://127.0.0.1:5173", origins), true);
  assert.equal(isOriginAllowed("https://daily-report-f.vercel.app", origins), true);
  assert.equal(isOriginAllowed(undefined, origins), true);
  assert.equal(isOriginAllowed("https://untrusted.example", origins), false);
});

test("session helpers set and clear an HttpOnly cookie", () => {
  const calls: { action: "set" | "clear"; name: string; value?: string; options: Record<string, unknown> }[] = [];
  const response = {
    cookie(name: string, value: string, options: Record<string, unknown>) {
      calls.push({ action: "set", name, value, options });
      return response;
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      calls.push({ action: "clear", name, options });
      return response;
    }
  } as unknown as Response;

  setSessionCookie(response, "signed-token");
  clearSessionCookie(response);

  assert.equal(calls[0].name, "dailyreport_session");
  assert.equal(calls[0].value, "signed-token");
  assert.equal(calls[0].options.httpOnly, true);
  assert.equal(calls[1].action, "clear");
  assert.equal("maxAge" in calls[1].options, false);
});
