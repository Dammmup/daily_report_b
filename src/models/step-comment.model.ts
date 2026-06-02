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

export const StepCommentModel = mongoose.model("StepComment", stepCommentSchema);
