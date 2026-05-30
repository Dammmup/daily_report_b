import type { NextFunction, Request, Response } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error(err);
  if (err instanceof Error && err.message.includes("Дэйлик за сегодня уже отправлен")) {
    res.status(409).json({ message: err.message });
    return;
  }
  res.status(500).json({ message: "Внутренняя ошибка сервера" });
}
