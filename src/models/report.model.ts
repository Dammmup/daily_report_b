import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from "mongoose";
import { aiReviewSchema } from "./shared.js";

const reportSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    date: { type: String, required: true, index: true },
    yesterday: { type: String, required: true },
    todayPlan: { type: String, required: true },
    blockers: { type: String, default: "" },
    linkedStepIds: { type: [Schema.Types.ObjectId], default: [] },
    source: { type: String, enum: ["web", "telegram"], default: "web" },
    status: { type: String, enum: ["submitted", "late"], default: "submitted" },
    aiReview: { type: aiReviewSchema }
  },
  { timestamps: true }
);

reportSchema.index({ userId: 1, createdAt: -1 });
reportSchema.index({ userId: 1, date: -1 });
reportSchema.index({ date: 1, userId: 1 });

export const ReportModel = mongoose.model("Report", reportSchema);
export type ReportDocument = HydratedDocument<InferSchemaType<typeof reportSchema>>;
