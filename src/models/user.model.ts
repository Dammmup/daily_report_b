import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from "mongoose";
import { categoryValues } from "../constants.js";

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    phone: { type: String, unique: true, sparse: true, trim: true },
    role: { type: String, enum: ["intern", "lead", "admin"], required: true },
    category: {
      type: String,
      enum: categoryValues,
      required: false
    },
    avatarColor: { type: String, required: true },
    avatarUrl: { type: String, default: "" },
    // file_unique_id последнего синхронизированного фото из Telegram — чтобы не перезаливать то же фото.
    telegramAvatarFileUniqueId: { type: String },
    bio: { type: String, default: "" },
    firstLoginCompleted: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    telegramChatId: { type: String },
    telegramUserId: { type: String, unique: true, sparse: true },
    telegramUsername: { type: String, sparse: true, lowercase: true, trim: true },
    telegramGroupChatId: { type: String },
    telegramActivityMessages: { type: Number, default: 0 },
    telegramActivityScore: { type: Number, default: 0 },
    telegramActivitySummary: { type: String, default: "" },
    telegramLastGroupSeenAt: { type: Date },
    telegramAiWindowStartedAt: { type: Date },
    telegramAiRepliesInWindow: { type: Number, default: 0 },
    telegramAiCooldownUntil: { type: Date },
    registrationSource: { type: String, enum: ["web", "telegram_group"], default: "web" },
    registrationReferrer: { type: String, default: "" },
    registrationUtmSource: { type: String, default: "" },
    registrationUtmMedium: { type: String, default: "" },
    registrationUtmCampaign: { type: String, default: "" },
    registrationSocialSource: { type: String, default: "" },
    telegramDigestEnabled: { type: Boolean, default: false },
    telegramDigestTime: { type: String, default: "18:00" },
    telegramDigestContent: { type: String, enum: ["productivity", "reports", "full"], default: "full" },
    telegramDigestLastSentAt: { type: Date },
    telegramFocusLastSentAt: { type: Date },
    telegramReportReminderLastSentAt: { type: Date },
    telegramLinkToken: { type: String },
    telegramLinkTokenExpiresAt: { type: Date },
    lastDepartmentChangedAt: { type: Date },
    lastDepartmentChangeReason: { type: String },
    passwordHash: { type: String, required: true },
    // Версия токена: инкремент инвалидирует все ранее выпущенные JWT (напр. при смене пароля).
    tokenVersion: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

userSchema.index({ role: 1, category: 1, name: 1 });
userSchema.index({ role: 1, category: 1, telegramActivityScore: -1 });
userSchema.index({ telegramChatId: 1 }, { sparse: true });
userSchema.index({ telegramLinkToken: 1, telegramLinkTokenExpiresAt: 1 }, { sparse: true });
userSchema.index({ category: 1, telegramDigestEnabled: 1, telegramDigestTime: 1 });
userSchema.index({ category: 1, telegramReportReminderLastSentAt: 1 });

export const UserModel = mongoose.model("User", userSchema);
export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>;
