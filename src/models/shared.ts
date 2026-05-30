import { Schema } from "mongoose";

export const aiReviewSchema = new Schema(
  {
    productivityScore: { type: Number, required: true },
    summary: { type: String, required: true },
    risks: { type: [String], default: [] },
    nextActions: { type: [String], default: [] },
    deadlineImpactDays: { type: Number, default: 0 },
    criteria: {
      resultClarity: { type: Number, default: 0 },
      planClarity: { type: Number, default: 0 },
      blockerControl: { type: Number, default: 0 },
      initiative: { type: Number, default: 0 }
    },
    explanation: { type: String, default: "" },
    confidence: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    model: { type: String, required: true }
  },
  { _id: false }
);

export const strengthProfileSchema = new Schema(
  {
    strengths: { type: [String], default: [] },
    weaknesses: { type: [String], default: [] },
    skillsSummary: { type: String, default: "" },
    experienceSummary: { type: String, default: "" },
    goalAlignment: { type: String, default: "" },
    suggestedTrack: { type: String, default: "" },
    mentorFocus: { type: [String], default: [] },
    recommendation: { type: String, required: true },
    riskLevel: { type: String, enum: ["low", "medium", "high"], required: true }
  },
  { _id: false }
);
