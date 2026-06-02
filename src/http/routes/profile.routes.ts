import { Router } from "express";
import { hashPassword, verifyPassword } from "../../auth.js";
import { AuditLogModel } from "../../models.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { passwordChangeSchema, profileUpdateSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const profileRouter = Router();

profileRouter.get("/me", auth, (req: AuthedRequest, res) => {
  res.json({ user: publicUser(req.user!) });
});



profileRouter.post("/me/telegram-link", auth, async (req: AuthedRequest, res) => {
  const user = req.user!;
  try {
    const token = crypto.randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
    user.telegramLinkToken = token;
    user.telegramLinkTokenExpiresAt = expires;
    await user.save();

    const botName = process.env.TELEGRAM_BOT_USERNAME || process.env.TELEGRAM_BOT_NAME;
    const deeplink = botName ? `https://t.me/${botName}?start=${token}` : null;

    res.json({ token, deeplink, expiresAt: expires.toISOString() });
  } catch (err) {
    console.error("Failed to create telegram link token", err);
    res.status(500).json({ message: "Не удалось создать токен привязки Telegram" });
  }
});
profileRouter.patch("/me", auth, async (req: AuthedRequest, res) => {
  const body = profileUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные данные профиля" });
    return;
  }

  req.user!.name = body.data.name;
  if (body.data.avatarColor) req.user!.avatarColor = body.data.avatarColor;
  req.user!.avatarUrl = body.data.avatarUrl || "";
  req.user!.bio = body.data.bio || "";
  await req.user!.save();

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "profile_updated",
    entityType: "user",
    entityId: req.user!.id,
    category: req.user!.category,
    message: "Пользователь обновил профиль"
  });

  res.json({ user: publicUser(req.user!) });
});

profileRouter.patch("/me/password", auth, async (req: AuthedRequest, res) => {
  const body = passwordChangeSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Введите текущий и новый пароль" });
    return;
  }

  if (!verifyPassword(body.data.currentPassword, req.user!.passwordHash)) {
    res.status(401).json({ message: "Текущий пароль неверный" });
    return;
  }

  req.user!.passwordHash = hashPassword(body.data.newPassword);
  await req.user!.save();

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "password_changed",
    entityType: "user",
    entityId: req.user!.id,
    category: req.user!.category,
    message: "Пользователь изменил пароль"
  });

  res.json({ ok: true });
});
