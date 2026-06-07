import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { UserDocument } from "./models.js";

const passwordIterations = 210_000;
const passwordKeyLength = 64;
const passwordDigest = "sha512";

function requiredProductionSecret(name: string, developmentFallback: string) {
  const value = process.env[name]?.trim();
  const production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  const insecureValues = new Set(["change-this-secret", "dev-dailyreport-secret"]);
  if (value && (!production || !insecureValues.has(value))) return value;
  if (production) {
    throw new Error(`${name} must be configured in production`);
  }
  return developmentFallback;
}

const jwtSecret = requiredProductionSecret("JWT_SECRET", "dev-dailyreport-secret");

export function signToken(user: UserDocument) {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "14d" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, jwtSecret) as { sub: string; role: string };
}

export function signOAuthState(input: {
  provider: string;
  userId: string;
  category?: string;
  redirectPath?: string;
}) {
  return jwt.sign(input, jwtSecret, { expiresIn: "10m" });
}

export function verifyOAuthState(token: string) {
  try {
    return jwt.verify(token, jwtSecret) as {
      provider: string;
      userId: string;
      category?: string;
      redirectPath?: string;
    };
  } catch {
    return null;
  }
}

export function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function hashCode(code: string) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, passwordIterations, passwordKeyLength, passwordDigest).toString("hex");
  return `pbkdf2$${passwordIterations}$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const modern = storedHash.split("$");
  if (modern.length === 4 && modern[0] === "pbkdf2") {
    const iterations = Number(modern[1]);
    const salt = modern[2];
    const hash = modern[3];
    if (!Number.isSafeInteger(iterations) || iterations < 1 || !salt || !hash) return false;
    const checkHash = crypto.pbkdf2Sync(password, salt, iterations, passwordKeyLength, passwordDigest);
    const expected = Buffer.from(hash, "hex");
    return expected.length === checkHash.length && crypto.timingSafeEqual(expected, checkHash);
  }

  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, passwordKeyLength, passwordDigest);
  const expected = Buffer.from(hash, "hex");
  return expected.length === checkHash.length && crypto.timingSafeEqual(expected, checkHash);
}

export function passwordNeedsRehash(storedHash: string) {
  const [algorithm, iterations] = storedHash.split("$");
  return algorithm !== "pbkdf2" || Number(iterations) < passwordIterations;
}

export function verifyTelegramInitData(initData: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (calculated.length !== hash.length) return null;
  const valid = crypto.timingSafeEqual(Buffer.from(calculated, "hex"), Buffer.from(hash, "hex"));
  if (!valid) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  return JSON.parse(userRaw) as { id: number; username?: string; first_name?: string; last_name?: string };
}
