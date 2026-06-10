import crypto from "node:crypto";
import type { Request } from "express";
import { AuthThrottleModel } from "../../models.js";

type ThrottleRule = {
  scope: string;
  identity: string;
  limit: number;
  windowMs: number;
  blockMs: number;
};

function throttleKey(scope: string, identity: string) {
  return crypto.createHash("sha256").update(`${scope}:${identity.trim().toLowerCase()}`).digest("hex");
}

export function requestIp(req: Request) {
  // req.ip уже вычисляется Express с учётом `trust proxy` (берёт самый левый недоверенный
  // адрес из X-Forwarded-For). Не парсим заголовок вручную — иначе клиент мог бы подделать
  // X-Forwarded-For и обойти лимит по IP.
  return req.ip || req.socket.remoteAddress || "unknown";
}

export async function consumeThrottle(rule: ThrottleRule) {
  const now = new Date();
  const keyHash = throttleKey(rule.scope, rule.identity);
  const expiresAt = new Date(now.getTime() + Math.max(rule.windowMs, rule.blockMs) * 2);
  const windowCutoff = new Date(now.getTime() - rule.windowMs);

  const reset = await AuthThrottleModel.findOneAndUpdate(
    { keyHash, windowStartedAt: { $lte: windowCutoff } },
    {
      $set: { attempts: 1, windowStartedAt: now, expiresAt },
      $unset: { blockedUntil: "" }
    },
    { returnDocument: "after" }
  );
  if (reset) return { allowed: true, retryAfterSeconds: 0 };

  const existing = await AuthThrottleModel.findOne({ keyHash });
  if (!existing) {
    try {
      await AuthThrottleModel.create({ keyHash, attempts: 1, windowStartedAt: now, expiresAt });
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("E11000")) throw error;
    }
  }

  const blocked = await AuthThrottleModel.findOne({ keyHash, blockedUntil: { $gt: now } });
  if (blocked?.blockedUntil) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blocked.blockedUntil.getTime() - now.getTime()) / 1000))
    };
  }

  const incremented = await AuthThrottleModel.findOneAndUpdate(
    {
      keyHash,
      attempts: { $lt: rule.limit },
      $or: [{ blockedUntil: { $exists: false } }, { blockedUntil: { $lte: now } }]
    },
    {
      $inc: { attempts: 1 },
      $set: { expiresAt }
    },
    { returnDocument: "after" }
  );
  if (incremented) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const blockedUntil = new Date(now.getTime() + rule.blockMs);
  await AuthThrottleModel.updateOne(
    { keyHash },
    {
      $set: {
        blockedUntil,
        expiresAt: new Date(blockedUntil.getTime() + rule.windowMs)
      }
    }
  );
  return { allowed: false, retryAfterSeconds: Math.ceil(rule.blockMs / 1000) };
}

export async function clearThrottle(scope: string, identity: string) {
  await AuthThrottleModel.deleteOne({ keyHash: throttleKey(scope, identity) });
}
