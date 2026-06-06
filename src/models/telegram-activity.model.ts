import mongoose, { Schema } from "mongoose";

const telegramActivitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    chatId: { type: String, required: true, index: true },
    messageId: { type: Number },
    text: { type: String, required: true },
    messageAt: { type: Date, default: Date.now },
    funRepliedAt: { type: Date }
  },
  { timestamps: true }
);

telegramActivitySchema.index({ userId: 1, messageAt: -1 });
telegramActivitySchema.index({ chatId: 1, messageAt: -1 });
telegramActivitySchema.index({ chatId: 1, funRepliedAt: 1, messageAt: -1 });

export const TelegramActivityModel = mongoose.model("TelegramActivity", telegramActivitySchema);
