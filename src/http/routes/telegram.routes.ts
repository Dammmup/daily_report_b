import { Router } from "express";
import { signToken, verifyTelegramInitData } from "../../auth.js";
import { UserModel } from "../../models.js";
import { handleTelegramWebhook, sendWeekdayGroupMotivation } from "../../telegram.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { telegramDigestSchema, telegramMiniAppSessionSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const telegramRouter = Router();

telegramRouter.post("/telegram/mini-app-session", async (req, res) => {
  const body = telegramMiniAppSessionSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные данные Telegram Mini App" });
    return;
  }

  const telegramUser = verifyTelegramInitData(body.data.initData);
  if (!telegramUser) {
    res.status(401).json({ message: "Не удалось проверить подпись Telegram Mini App" });
    return;
  }

  const user = await UserModel.findOne({
    $or: [
      { telegramUserId: String(telegramUser.id) },
      ...(telegramUser.username ? [{ telegramUsername: telegramUser.username.toLowerCase() }] : [])
    ]
  });

  if (!user || !user.emailVerified) {
    res.status(404).json({ message: "Telegram еще не привязан к подтвержденному аккаунту" });
    return;
  }

  user.telegramUserId = String(telegramUser.id);
  if (telegramUser.username) user.telegramUsername = telegramUser.username.toLowerCase();
  user.lastActiveAt = new Date();
  await user.save();

  res.json({ token: signToken(user), user: publicUser(user) });
});

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
