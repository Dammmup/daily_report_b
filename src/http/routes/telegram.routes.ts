import { Router } from "express";
import type { Request, Response } from "express";
import { signToken, verifyTelegramInitData } from "../../auth.js";
import { categories } from "../../constants.js";
import { TelegramGroupModel, UserModel } from "../../models.js";
import {
  handleTelegramWebhook,
  sendRandomTelegramFunReply,
  sendTelegramProductivityAutomation,
  sendWeekdayGroupDailyDigests,
  sendWeekdayGroupMotivation,
  sendWeekdayPersonalFocus,
  sendWeekdayReportReminders
} from "../../telegram.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { telegramDigestSchema, telegramMiniAppSessionSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const telegramRouter = Router();
const telegramWebhookAllowedUpdates = ["message", "callback_query", "my_chat_member"];

function backendBaseUrl(req: Request) {
  if (process.env.TELEGRAM_WEBHOOK_URL) return process.env.TELEGRAM_WEBHOOK_URL.replace(/\/api\/telegram\/webhook\/?$/, "");
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  const proto = req.header("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function serializeTelegramGroup(group: Awaited<ReturnType<typeof TelegramGroupModel.findOne>>) {
  if (!group) return null;
  return {
    id: group.id,
    chatId: group.chatId,
    title: group.title,
    category: group.category || undefined,
    categoryLabel: group.category ? categories[group.category as Category] : undefined,
    active: group.active !== false,
    isPrimary: Boolean(group.isPrimary),
    membersSeen: group.membersSeen || 0,
    motivationEnabled: Boolean(group.motivationEnabled),
    funEnabled: Boolean(group.funEnabled),
    funMediaCount: group.funMedia.length,
    funLastReplyAt: group.funLastReplyAt?.toISOString(),
    funNextReplyAt: group.funNextReplyAt?.toISOString(),
    lastActivityAt: group.lastActivityAt?.toISOString(),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString()
  };
}

function telegramGroupScope(req: AuthedRequest) {
  if (req.user!.role === "admin") return {};
  return req.user!.category ? { category: req.user!.category } : null;
}

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

telegramRouter.get("/telegram/groups", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const scope = telegramGroupScope(req);
  if (!scope) {
    res.json([]);
    return;
  }

  const groups = await TelegramGroupModel.find(scope).sort({ category: 1, active: -1, isPrimary: -1, lastActivityAt: -1, createdAt: -1 });
  res.json(groups.map(serializeTelegramGroup));
});

telegramRouter.post("/telegram/groups/:id/primary", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const scope = telegramGroupScope(req);
  if (!scope) {
    res.status(400).json({ message: "Сначала выберите департамент" });
    return;
  }

  const group = await TelegramGroupModel.findOne({ _id: req.params.id, ...scope });
  if (!group) {
    res.status(404).json({ message: "Telegram-чат не найден" });
    return;
  }
  if (!group.category) {
    res.status(400).json({ message: "Сначала привяжите чат к департаменту" });
    return;
  }
  if (group.active === false) {
    res.status(400).json({ message: "Нельзя выбрать неактивный чат основным. Добавьте бота обратно в чат." });
    return;
  }

  await TelegramGroupModel.updateMany({ category: group.category, _id: { $ne: group._id } }, { $set: { isPrimary: false } });
  group.isPrimary = true;
  group.active = true;
  group.lastActivityAt = new Date();
  await group.save();

  res.json(serializeTelegramGroup(group));
});

telegramRouter.post("/telegram/webhook", async (req, res, next) => {
  try {
    await handleTelegramWebhook(req.body);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

telegramRouter.post("/telegram/webhook/setup", auth, requireRole("admin"), async (req: Request, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(400).json({ message: "TELEGRAM_BOT_TOKEN не задан" });
    return;
  }

  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL || `${backendBaseUrl(req)}/api/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: telegramWebhookAllowedUpdates,
      drop_pending_updates: false
    })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    res.status(400).json({ message: "Не удалось настроить Telegram webhook", result });
    return;
  }

  res.json({ ok: true, webhookUrl, allowedUpdates: telegramWebhookAllowedUpdates, result });
});

telegramRouter.all("/telegram/motivation-cron", async (req, res, next) => {
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

telegramRouter.all("/telegram/productivity-cron", async (req, res, next) => {
  try {
    if (!authorizeCron(req, res)) return;

    const result = await sendTelegramProductivityAutomation();
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

telegramRouter.all("/telegram/personal-focus-cron", async (req, res, next) => {
  try {
    if (!authorizeCron(req, res)) return;
    res.json({ ok: true, ...(await sendWeekdayPersonalFocus()) });
  } catch (error) {
    next(error);
  }
});

telegramRouter.all("/telegram/report-reminder-cron", async (req, res, next) => {
  try {
    if (!authorizeCron(req, res)) return;
    res.json({ ok: true, ...(await sendWeekdayReportReminders()) });
  } catch (error) {
    next(error);
  }
});

telegramRouter.all("/telegram/group-digest-cron", async (req, res, next) => {
  try {
    if (!authorizeCron(req, res)) return;
    res.json({ ok: true, ...(await sendWeekdayGroupDailyDigests()) });
  } catch (error) {
    next(error);
  }
});

telegramRouter.all("/telegram/fun-cron", async (req, res, next) => {
  try {
    if (!authorizeCron(req, res)) return;
    res.json({ ok: true, ...(await sendRandomTelegramFunReply()) });
  } catch (error) {
    next(error);
  }
});

function authorizeCron(req: Request, res: Response) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.header("authorization");
  if (secret && authHeader !== `Bearer ${secret}` && req.header("x-cron-secret") !== secret && req.query.secret !== secret) {
    res.status(401).json({ message: "Unauthorized cron request" });
    return false;
  }
  return true;
}
