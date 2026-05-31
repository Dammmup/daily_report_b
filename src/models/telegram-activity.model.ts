import mongoose, { Schema } from "mongoose";

const telegramActivitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    chatId: { type: String, required: true, index: true },
    text: { type: String, required: true },
    messageAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const TelegramActivityModel = mongoose.model("TelegramActivity", telegramActivitySchema);
