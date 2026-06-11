import { Router } from "express";
import type { Request, Response } from "express";
import { generateVerificationCode, hashCode, hashPassword, passwordNeedsRehash, signToken, verifyPassword, verifyTelegramLoginWidget } from "../../auth.js";
import { randomAvatarColor } from "../../constants.js";
import { sendVerificationEmail } from "../../mailer.js";
import { UserModel, VerificationCodeModel } from "../../models.js";
import { loginSchema, requestCodeSchema, telegramLoginSchema, verifyEmailSchema } from "../schemas.js";
import { clearThrottle, consumeThrottle, requestIp } from "../security/auth-throttle.js";
import { clearSessionCookie, setSessionCookie } from "../security/session-cookie.js";
import { publicUser } from "../serializers.js";

export const authRouter = Router();
const authWindowMs = 15 * 60 * 1000;
const dummyPasswordHash = hashPassword("not-a-real-user-password");

async function allowAuthRequest(
  req: Request,
  res: Response,
  input: { scope: string; identity: string; identityLimit: number; ipLimit: number; blockMs?: number }
) {
  const blockMs = input.blockMs || authWindowMs;
  const [identityResult, ipResult] = await Promise.all([
    consumeThrottle({
      scope: `${input.scope}:identity`,
      identity: input.identity,
      limit: input.identityLimit,
      windowMs: authWindowMs,
      blockMs
    }),
    consumeThrottle({
      scope: `${input.scope}:ip`,
      identity: requestIp(req),
      limit: input.ipLimit,
      windowMs: authWindowMs,
      blockMs
    })
  ]);
  const denied = !identityResult.allowed ? identityResult : !ipResult.allowed ? ipResult : null;
  if (!denied) return true;

  res.setHeader("Retry-After", String(denied.retryAfterSeconds));
  res.status(429).json({ message: "Слишком много попыток. Попробуйте позже." });
  return false;
}

const socialSourcePatterns = [
  { source: "telegram", patterns: ["telegram", "t.me", "telegra.ph"] },
  { source: "instagram", patterns: ["instagram"] },
  { source: "facebook", patterns: ["facebook", "fb.com", "m.facebook"] },
  { source: "linkedin", patterns: ["linkedin"] },
  { source: "x", patterns: ["twitter", "x.com", "t.co"] },
  { source: "youtube", patterns: ["youtube", "youtu.be"] },
  { source: "tiktok", patterns: ["tiktok"] },
  { source: "vk", patterns: ["vk.com", "vkontakte"] },
  { source: "whatsapp", patterns: ["whatsapp", "wa.me"] }
];

function cleanMetaValue(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function referrerHostname(referrer: string) {
  try {
    return referrer ? new URL(referrer).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function detectSocialSource(input: { referrer: string; utmSource: string }) {
  const text = `${input.utmSource} ${referrerHostname(input.referrer)} ${input.referrer}`.toLowerCase();
  return socialSourcePatterns.find((item) => item.patterns.some((pattern) => text.includes(pattern)))?.source || "";
}

function registrationAttribution(meta: unknown) {
  const source = typeof meta === "object" && meta ? (meta as Record<string, unknown>) : {};
  const referrer = cleanMetaValue(source.referrer, 1000);
  const utmSource = cleanMetaValue(source.utmSource, 120);
  const utmMedium = cleanMetaValue(source.utmMedium, 120);
  const utmCampaign = cleanMetaValue(source.utmCampaign, 200);
  return {
    registrationReferrer: referrer,
    registrationUtmSource: utmSource,
    registrationUtmMedium: utmMedium,
    registrationUtmCampaign: utmCampaign,
    registrationSocialSource: detectSocialSource({ referrer, utmSource })
  };
}

authRouter.post("/request-code", async (req, res) => {
  const body = requestCodeSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Проверьте введенные данные профиля" });
    return;
  }

  const email = body.data.email ? body.data.email.toLowerCase() : undefined;
  const phone = body.data.phone ? body.data.phone.trim() : undefined;
  const contact = email || phone!;
  const allowDevCode =
    process.env.ALLOW_DEV_VERIFICATION_CODE === "true" &&
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL !== "1";
  if (!email && !allowDevCode) {
    res.status(503).json({ message: "Подтверждение телефона пока не настроено. Используйте email." });
    return;
  }
  if (!(await allowAuthRequest(req, res, { scope: "request-code", identity: contact, identityLimit: 3, ipLimit: 100 }))) return;

  const passwordHash = hashPassword(body.data.password);
  const attribution = registrationAttribution(body.data.registrationMeta);

  let user = null;
  if (email) user = await UserModel.findOne({ email });
  if (!user && phone) user = await UserModel.findOne({ phone });

  if (!user) {
    user = await UserModel.create({
      name: body.data.name,
      email,
      phone,
      role: "intern",
      avatarColor: randomAvatarColor(),
      emailVerified: false,
      firstLoginCompleted: false,
      registrationSource: "web",
      ...attribution,
      passwordHash
    });
  } else if (!user.emailVerified) {
    user.name = body.data.name || user.name;
    user.role = "intern";
    user.passwordHash = passwordHash;
    if (email) user.email = email;
    if (phone) user.phone = phone;
    user.registrationSource = "web";
    user.registrationReferrer = attribution.registrationReferrer;
    user.registrationUtmSource = attribution.registrationUtmSource;
    user.registrationUtmMedium = attribution.registrationUtmMedium;
    user.registrationUtmCampaign = attribution.registrationUtmCampaign;
    user.registrationSocialSource = attribution.registrationSocialSource;
    await user.save();
  } else {
    res.status(400).json({ message: "Пользователь с таким контактом уже зарегистрирован" });
    return;
  }

  const code = generateVerificationCode();
  await VerificationCodeModel.deleteMany({ email: contact, usedAt: { $exists: false } });
  await VerificationCodeModel.create({
    email: contact,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + 1000 * 60 * 15)
  });

  let delivery: { delivered: boolean; devCode?: string } = { delivered: false, devCode: allowDevCode ? code : undefined };
  if (email) {
    delivery = await sendVerificationEmail(email, code);
    if (!delivery.delivered && !allowDevCode) {
      res.status(500).json({ message: "Не удалось отправить код подтверждения на почту." });
      return;
    }
  }

  res.json({
    ok: true,
    delivered: delivery.delivered,
    devCode: delivery.delivered ? undefined : delivery.devCode
  });
});

authRouter.post("/verify", async (req, res) => {
  const body = verifyEmailSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Укажите контакт и 6-значный код" });
    return;
  }

  const email = body.data.email ? body.data.email.toLowerCase() : undefined;
  const phone = body.data.phone ? body.data.phone.trim() : undefined;
  const contact = email || phone;
  if (!(await allowAuthRequest(req, res, { scope: "verify-code", identity: contact!, identityLimit: 6, ipLimit: 120 }))) return;

  const verification = await VerificationCodeModel.findOne({
    email: contact,
    codeHash: hashCode(body.data.code),
    usedAt: { $exists: false },
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });

  if (!verification) {
    res.status(400).json({ message: "Код неверный или истек" });
    return;
  }

  let user = null;
  if (email) user = await UserModel.findOne({ email });
  if (!user && phone) user = await UserModel.findOne({ phone });

  if (!user) {
    res.status(404).json({ message: "Пользователь не найден" });
    return;
  }

  verification.usedAt = new Date();
  user.emailVerified = true;
  user.lastActiveAt = new Date();
  await Promise.all([verification.save(), user.save()]);
  await clearThrottle("verify-code:identity", contact!);
  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({ token, user: publicUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Укажите логин и пароль" });
    return;
  }

  const identifier = body.data.identifier.trim();
  const normalizedIdentifier = identifier.toLowerCase();
  if (!(await allowAuthRequest(req, res, { scope: "login", identity: normalizedIdentifier, identityLimit: 8, ipLimit: 150, blockMs: 30 * 60 * 1000 }))) {
    return;
  }
  const user = await UserModel.findOne({
    $or: [{ email: normalizedIdentifier }, { phone: identifier }]
  });

  const passwordValid = verifyPassword(body.data.password, user?.passwordHash || dummyPasswordHash);
  if (!user || !passwordValid) {
    res.status(401).json({ message: "Неверный логин или пароль" });
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ message: "Аккаунт не подтвержден. Пожалуйста, завершите регистрацию." });
    return;
  }

  if (passwordNeedsRehash(user.passwordHash)) user.passwordHash = hashPassword(body.data.password);
  user.lastActiveAt = new Date();
  await user.save();
  await clearThrottle("login:identity", normalizedIdentifier);
  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({ token, user: publicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Вход через Telegram Login Widget («Войти через Telegram» на странице логина).
authRouter.post("/telegram", async (req, res) => {
  const body = telegramLoginSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные данные входа через Telegram" });
    return;
  }

  const telegramUser = verifyTelegramLoginWidget(req.body as Record<string, unknown>);
  if (!telegramUser) {
    res.status(401).json({ message: "Не удалось проверить подпись Telegram" });
    return;
  }

  if (!(await allowAuthRequest(req, res, { scope: "telegram-login", identity: String(telegramUser.id), identityLimit: 10, ipLimit: 100 }))) {
    return;
  }

  const username = telegramUser.username?.toLowerCase();
  const user = await UserModel.findOne({
    $or: [{ telegramUserId: String(telegramUser.id) }, ...(username ? [{ telegramUsername: username }] : [])]
  });

  if (!user || !user.emailVerified) {
    res.status(404).json({
      message: "Telegram не привязан к подтвержденному аккаунту. Сначала привяжите Telegram в профиле или завершите регистрацию."
    });
    return;
  }

  user.telegramUserId = String(telegramUser.id);
  if (username) user.telegramUsername = username;
  user.lastActiveAt = new Date();
  await user.save();
  await clearThrottle("telegram-login:identity", String(telegramUser.id));

  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({ token, user: publicUser(user) });
});
