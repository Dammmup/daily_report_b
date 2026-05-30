import mongoose, { Schema } from "mongoose";

const issueSchema = new Schema(
  {
    title: { type: String, required: true },
    severity: { type: String, enum: ["low", "medium", "high"], required: true },
    impactDays: { type: Number, default: 0 },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const planSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    category: {
      type: String,
      enum: ["data-system-ml", "marketing-sales", "erp-development", "data-security"],
      required: true,
      unique: true,
      index: true
    },
    status: { type: String, enum: ["draft", "approved"], default: "approved" },
    startDate: { type: String, required: true },
    baseDeadline: { type: String, required: true },
    adjustedDeadline: { type: String, required: true },
    milestones: { type: [String], default: [] },
    issues: { type: [issueSchema], default: [] },
    aiRationale: { type: String, required: true }
  },
  { timestamps: true }
);

export const PlanModel = mongoose.model("Plan", planSchema);
