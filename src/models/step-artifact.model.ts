import mongoose, { Schema } from "mongoose";

const stepArtifactSchema = new Schema(
  {
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    stepId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    url: { type: String, required: true }
  },
  { timestamps: true }
);

export const StepArtifactModel = mongoose.model("StepArtifact", stepArtifactSchema);
