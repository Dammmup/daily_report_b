import mongoose, { Schema } from "mongoose";

const externalResourceAiCheckSchema = new Schema(
  {
    resourceId: { type: Schema.Types.ObjectId, ref: "ExternalResource", required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    matchScore: { type: Number, required: true, min: 0, max: 100 },
    riskLevel: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    summary: { type: String, required: true },
    matchedSteps: { type: [String], default: [] },
    missingRequirements: { type: [String], default: [] },
    suggestedActions: { type: [String], default: [] },
    rawResponse: { type: String, default: "" }
  },
  { timestamps: true }
);

externalResourceAiCheckSchema.index({ resourceId: 1, createdAt: -1 });
externalResourceAiCheckSchema.index({ planId: 1, createdAt: -1 });

export const ExternalResourceAiCheckModel = mongoose.model("ExternalResourceAiCheck", externalResourceAiCheckSchema);
