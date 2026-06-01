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

const stepSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
    deadline: { type: String, required: true },
    status: { type: String, enum: ["todo", "in_progress", "done", "canceled"], default: "todo" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: false },
    source: { type: String, enum: ["ai", "manual"], default: "ai" }
  },
  { _id: true, timestamps: true }
);

const planSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    category: {
      type: String,
      enum: ["data-system-ml", "marketing-sales", "erp-development", "data-security"],
      required: true,
      index: true
    },
    version: { type: Number, default: 1 },
    status: { type: String, enum: ["draft", "approved", "completed", "archived"], default: "approved", index: true },
    startDate: { type: String, required: true },
    baseDeadline: { type: String, required: true },
    adjustedDeadline: { type: String, required: true },
    milestones: { type: [String], default: [] },
    steps: { type: [stepSchema], default: [] },
    issues: { type: [issueSchema], default: [] },
    aiRationale: { type: String, required: true },
    completedAt: { type: Date }
  },
  { timestamps: true }
);

planSchema.index({ category: 1, status: 1, createdAt: -1 });

export const PlanModel = mongoose.model("Plan", planSchema);
