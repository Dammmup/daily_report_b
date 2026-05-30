import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { UserDocument } from "./models.js";

const jwtSecret = process.env.JWT_SECRET || "dev-dailyreport-secret";

export function signToken(user: UserDocument) {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "14d" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, jwtSecret) as { sub: string; role: string };
}

export function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function hashCode(code: string) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return hash === checkHash;
}
