import mongoose, { Schema } from "mongoose";

const telegramGroupSchema = new Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    category: {
      type: String,
      enum: ["data-system-ml", "marketing-sales", "erp-development", "data-security"],
      required: false
    },
    membersSeen: { type: Number, default: 0 },
    motivationEnabled: { type: Boolean, default: true },
    motivationLastSentAt: { type: Date },
    lastActivityAt: { type: Date }
  },
  { timestamps: true }
);

export const TelegramGroupModel = mongoose.model("TelegramGroup", telegramGroupSchema);
