import { Router } from "express";
import { generateVerificationCode, hashCode, hashPassword, signToken, verifyPassword } from "../../auth.js";
import { randomAvatarColor } from "../../constants.js";
import { sendVerificationEmail } from "../../mailer.js";
import { UserModel, VerificationCodeModel } from "../../models.js";
import { loginSchema, requestCodeSchema, verifyEmailSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const authRouter = Router();

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
  await VerificationCodeModel.create({
    email: email || phone,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + 1000 * 60 * 15)
  });

  let delivery = { delivered: false, devCode: code };
  if (email) {
    delivery = await sendVerificationEmail(email, code);
    const allowDevCode = process.env.ALLOW_DEV_VERIFICATION_CODE === "true" || process.env.NODE_ENV !== "production";
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
  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Укажите логин и пароль" });
    return;
  }

  const identifier = body.data.identifier.trim();
  const user = await UserModel.findOne({
    $or: [{ email: identifier.toLowerCase() }, { phone: identifier }]
  });

  if (!user) {
    res.status(404).json({ message: "Пользователь не найден. Пожалуйста, пройдите регистрацию." });
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ message: "Аккаунт не подтвержден. Пожалуйста, завершите регистрацию." });
    return;
  }

  if (!verifyPassword(body.data.password, user.passwordHash)) {
    res.status(401).json({ message: "Неверный пароль" });
    return;
  }

  user.lastActiveAt = new Date();
  await user.save();
  res.json({ token: signToken(user), user: publicUser(user) });
});
