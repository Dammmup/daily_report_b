import mongoose, { Schema } from "mongoose";

const stepCommentSchema = new Schema(
  {
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    stepId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true }
  },
  { timestamps: true }
);

stepCommentSchema.index({ stepId: 1, createdAt: 1 });
stepCommentSchema.index({ planId: 1, stepId: 1 });

export const StepCommentModel = mongoose.model("StepComment", stepCommentSchema);
