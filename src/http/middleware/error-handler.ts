import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = crypto.randomUUID();
  console.error(`[${requestId}] ${req.method} ${req.originalUrl}`, err);
  if (err instanceof Error && err.message.includes("Дэйлик за сегодня уже отправлен")) {
    res.status(409).json({ message: err.message, requestId });
    return;
  }
  res.status(500).json({
    message: "Внутренняя ошибка сервера",
    requestId,
    detail: process.env.NODE_ENV === "production" ? undefined : err instanceof Error ? err.message : String(err)
  });
}
