import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../../auth.js";
import { UserModel, type UserDocument } from "../../models.js";
import type { Role } from "../../types.js";
import { readSessionCookie } from "../security/session-cookie.js";

export type AuthedRequest = Request & { user?: UserDocument };

// Не пишем lastActiveAt в БД чаще, чем раз в это окно — убирает запись на КАЖДЫЙ запрос.
const lastActiveWriteIntervalMs = 5 * 60 * 1000;

export async function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const tokens = [
    req.header("authorization")?.replace(/^Bearer\s+/i, ""),
    readSessionCookie(req)
  ].filter((token, index, items): token is string => Boolean(token) && items.indexOf(token) === index);
  if (!tokens.length) {
    res.status(401).json({ message: "Нужна авторизация" });
    return;
  }

  for (const token of tokens) {
    try {
      const payload = verifyToken(token);
      const user = await UserModel.findById(payload.sub);
      if (!user) continue;

      // Ревокация: токен с устаревшей версией (например, после смены пароля) недействителен.
      if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) continue;

      const now = new Date();
      const lastActive = user.lastActiveAt?.getTime() ?? 0;
      if (now.getTime() - lastActive >= lastActiveWriteIntervalMs) {
        // Лёгкое условное обновление вместо полного user.save() на каждый запрос.
        user.lastActiveAt = now;
        await UserModel.updateOne({ _id: user._id }, { $set: { lastActiveAt: now } });
      }
      req.user = user;
      next();
      return;
    } catch {
      // Try the cookie when a legacy bearer token has expired.
    }
  }

  res.status(401).json({ message: "Сессия истекла" });
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: "Недостаточно прав" });
      return;
    }
    next();
  };
}
