import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { configuredAllowedOrigins, isOriginAllowed, originCsrfGuard } from "./app.js";
import { clearSessionCookie, setSessionCookie } from "./http/security/session-cookie.js";

test("CORS allows only configured frontend origins", () => {
  const origins = configuredAllowedOrigins();
  assert.equal(isOriginAllowed("http://127.0.0.1:5173", origins), true);
  assert.equal(isOriginAllowed("https://daily-report-f.vercel.app", origins), true);
  assert.equal(isOriginAllowed(undefined, origins), true);
  assert.equal(isOriginAllowed("https://untrusted.example", origins), false);
});

test("originCsrfGuard blocks mutating requests from foreign origins", () => {
  const origins = configuredAllowedOrigins();
  const guard = originCsrfGuard(origins);

  const run = (method: string, origin?: string) => {
    let status = 0;
    let nextCalled = false;
    const req = { method, header: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined) } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      }
    } as unknown as Response;
    guard(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);
    return { status, nextCalled };
  };

  // Чужой Origin на мутирующем методе — 403.
  assert.deepEqual(run("POST", "https://evil.example"), { status: 403, nextCalled: false });
  // Разрешённый Origin — пропускаем.
  assert.deepEqual(run("POST", "https://daily-report-f.vercel.app"), { status: 0, nextCalled: true });
  // Без Origin (server-to-server: вебхук/крон) — пропускаем.
  assert.deepEqual(run("POST", undefined), { status: 0, nextCalled: true });
  // GET не трогаем даже с чужим Origin.
  assert.deepEqual(run("GET", "https://evil.example"), { status: 0, nextCalled: true });
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
