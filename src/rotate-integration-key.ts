import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { connectMongo } from "./mongo.js";
import { IntegrationConnectionModel } from "./models.js";

function keyFromSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest();
}

function decrypt(value: string, secret: string) {
  if (!value) return "";
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted integration value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

function encrypt(value: string, secret: string) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptWithCurrentOrLegacy(value: string, currentSecret: string, legacySecret: string) {
  if (!value) return { value: "", migrated: false };
  try {
    return { value: decrypt(value, currentSecret), migrated: false };
  } catch {
    return { value: decrypt(value, legacySecret), migrated: true };
  }
}

async function main() {
  const currentSecret = process.env.INTEGRATION_ENCRYPTION_KEY?.trim();
  const legacySecret = process.env.JWT_SECRET?.trim();
  if (!currentSecret || !legacySecret) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY and JWT_SECRET are required");
  }

  await connectMongo();
  const connections = await IntegrationConnectionModel.find({
    $or: [{ accessTokenEncrypted: { $ne: "" } }, { refreshTokenEncrypted: { $ne: "" } }]
  });
  let migrated = 0;
  let needsReauth = 0;

  for (const connection of connections) {
    let accessToken;
    let refreshToken;
    try {
      accessToken = decryptWithCurrentOrLegacy(connection.accessTokenEncrypted, currentSecret, legacySecret);
      refreshToken = decryptWithCurrentOrLegacy(connection.refreshTokenEncrypted, currentSecret, legacySecret);
    } catch {
      connection.status = "needs_reauth";
      connection.accessTokenEncrypted = "";
      connection.refreshTokenEncrypted = "";
      await connection.save();
      needsReauth += 1;
      continue;
    }
    if (!accessToken.migrated && !refreshToken.migrated) continue;

    connection.accessTokenEncrypted = encrypt(accessToken.value, currentSecret);
    connection.refreshTokenEncrypted = encrypt(refreshToken.value, currentSecret);
    await connection.save();
    migrated += 1;
  }

  await mongoose.disconnect();
  console.log(`Integration encryption migration completed. Updated: ${migrated}. Needs reauth: ${needsReauth}.`);
}

main().catch(async (error) => {
  console.error("Integration encryption migration failed", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
