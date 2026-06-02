import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    phone: { type: String, unique: true, sparse: true, trim: true },
    role: { type: String, enum: ["intern", "lead", "admin"], required: true },
    category: {
      type: String,
      enum: ["data-system-ml", "marketing-sales", "erp-development", "data-security"],
      required: false
    },
    avatarColor: { type: String, required: true },
    avatarUrl: { type: String, default: "" },
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
    registrationSource: { type: String, enum: ["web", "telegram_group"], default: "web" },
    telegramDigestEnabled: { type: Boolean, default: false },
    telegramDigestTime: { type: String, default: "18:00" },
    telegramDigestContent: { type: String, enum: ["productivity", "reports", "full"], default: "full" },
    telegramDigestLastSentAt: { type: Date },
    telegramLinkToken: { type: String },
    telegramLinkTokenExpiresAt: { type: Date },
    passwordHash: { type: String, required: true },
    lastActiveAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const UserModel = mongoose.model("User", userSchema);
export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>;
