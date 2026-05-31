import { Router } from "express";
import { handleTelegramWebhook, sendWeekdayGroupMotivation } from "../../telegram.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { telegramDigestSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const telegramRouter = Router();

telegramRouter.get("/telegram/digest", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  res.json({
    enabled: Boolean(req.user!.telegramDigestEnabled),
    time: req.user!.telegramDigestTime || "18:00",
    content: req.user!.telegramDigestContent || "full"
  });
});

telegramRouter.patch("/telegram/digest", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const body = telegramDigestSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные настройки Telegram-сводки" });
    return;
  }

  req.user!.telegramDigestEnabled = body.data.enabled;
  req.user!.telegramDigestTime = body.data.time;
  req.user!.telegramDigestContent = body.data.content;
  await req.user!.save();

  res.json({ user: publicUser(req.user!) });
});

telegramRouter.post("/telegram/webhook", async (req, res, next) => {
  try {
    await handleTelegramWebhook(req.body);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

telegramRouter.post("/telegram/motivation-cron", async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.header("authorization");
    if (secret && authHeader !== `Bearer ${secret}` && req.header("x-cron-secret") !== secret && req.query.secret !== secret) {
      res.status(401).json({ message: "Unauthorized cron request" });
      return;
    }

    const result = await sendWeekdayGroupMotivation();
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});
