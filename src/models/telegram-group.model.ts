import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

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
    motivationEnabled: { type: Boolean, default: true },
    motivationLastSentAt: { type: Date },
    groupDigestLastSentAt: { type: Date },
    dailyReminderLastSentAt: { type: Date },
    lastActivityAt: { type: Date }
  },
  { timestamps: true }
);

telegramGroupSchema.index({ category: 1, motivationEnabled: 1 });
telegramGroupSchema.index({ category: 1, groupDigestLastSentAt: 1 });
telegramGroupSchema.index({ category: 1, dailyReminderLastSentAt: 1 });

export const TelegramGroupModel = mongoose.model("TelegramGroup", telegramGroupSchema);
