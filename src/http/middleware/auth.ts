import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../../auth.js";
import { UserModel, type UserDocument } from "../../models.js";
import type { Role } from "../../types.js";

export type AuthedRequest = Request & { user?: UserDocument };

export async function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ message: "Нужна авторизация" });
    return;
  }

  try {
    const payload = verifyToken(token);
    const user = await UserModel.findById(payload.sub);
    if (!user) {
      res.status(401).json({ message: "Сессия не найдена" });
      return;
    }

    user.lastActiveAt = new Date();
    await user.save();
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Сессия истекла" });
  }
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
