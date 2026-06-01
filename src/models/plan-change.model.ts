import mongoose, { Schema } from "mongoose";

const planChangeSchema = new Schema(
  {
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    category: {
      type: String,
      enum: ["data-system-ml", "marketing-sales", "erp-development", "data-security"],
      required: true,
      index: true
    },
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["plan_created", "plan_updated", "step_added", "step_updated", "step_assigned", "deadline_changed"],
      required: true
    },
    title: { type: String, required: true },
    summary: { type: String, required: true },
    stepId: { type: String },
    recipientsCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const PlanChangeModel = mongoose.model("PlanChange", planChangeSchema);
