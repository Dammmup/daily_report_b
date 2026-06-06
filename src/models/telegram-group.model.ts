import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

const telegramFunMediaSchema = new Schema(
  {
    type: { type: String, enum: ["animation", "sticker"], required: true },
    fileId: { type: String, required: true },
    fileUniqueId: { type: String },
    addedByTelegramUserId: { type: String },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const telegramGroupSchema = new Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    category: {
      type: String,
      enum: categoryValues,
      required: false
    },
    membersSeen: { type: Number, default: 0 },
    active: { type: Boolean, default: true, index: true },
    isPrimary: { type: Boolean, default: false, index: true },
    motivationEnabled: { type: Boolean, default: true },
    motivationLastSentAt: { type: Date },
    funEnabled: { type: Boolean, default: false },
    funMedia: { type: [telegramFunMediaSchema], default: [] },
    funLastReplyAt: { type: Date },
    funNextReplyAt: { type: Date, index: true },
    groupDigestLastSentAt: { type: Date },
    dailyReminderLastSentAt: { type: Date },
    lastActivityAt: { type: Date }
  },
  { timestamps: true }
);

telegramGroupSchema.index({ category: 1, active: 1, motivationEnabled: 1 });
telegramGroupSchema.index({ category: 1, active: 1, isPrimary: 1 });
telegramGroupSchema.index({ active: 1, funEnabled: 1, funNextReplyAt: 1 });
telegramGroupSchema.index({ category: 1, groupDigestLastSentAt: 1 });
telegramGroupSchema.index({ category: 1, dailyReminderLastSentAt: 1 });

export const TelegramGroupModel = mongoose.model("TelegramGroup", telegramGroupSchema);
