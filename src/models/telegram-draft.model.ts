import mongoose, { Schema } from "mongoose";

const telegramDraftSchema = new Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    flow: { type: String, enum: ["daily", "blocker"], required: true },
    step: { type: String, required: true },
    stepId: { type: String },
    yesterday: { type: String, default: "" },
    todayPlan: { type: String, default: "" },
    blockers: { type: String, default: "" },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  { timestamps: true }
);

export const TelegramDraftModel = mongoose.model("TelegramDraft", telegramDraftSchema);
