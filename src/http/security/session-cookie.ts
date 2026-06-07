import type { Request, Response } from "express";

export const sessionCookieName = "dailyreport_session";
const sessionMaxAgeMs = 14 * 24 * 60 * 60 * 1000;

function isProduction() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function cookieOptions() {
  const production = isProduction();
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? ("none" as const) : ("lax" as const),
    path: "/",
    maxAge: sessionMaxAgeMs
  };
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(sessionCookieName, token, cookieOptions());
}

export function clearSessionCookie(res: Response) {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(sessionCookieName, options);
}

export function readSessionCookie(req: Request) {
  const cookieHeader = req.header("cookie");
  if (!cookieHeader) return undefined;

  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (rawName === sessionCookieName) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
