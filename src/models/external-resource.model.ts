import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

const externalResourceSchema = new Schema(
  {
    provider: { type: String, enum: ["google_drive", "trello", "notion", "manual"], required: true, index: true },
    externalId: { type: String, default: "" },
    externalUrl: { type: String, required: true },
    title: { type: String, required: true },
    resourceType: { type: String, enum: ["folder", "document", "board", "card", "page", "database", "other"], required: true },
    linkedEntityType: { type: String, enum: ["department", "plan", "step"], required: true },
    linkedEntityId: { type: String, required: true },
    category: { type: String, enum: categoryValues, required: false, index: true },
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: false, index: true },
    stepId: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    contentSummary: { type: String, default: "" },
    lastAiCheckAt: { type: Date },
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

externalResourceSchema.index({ linkedEntityType: 1, linkedEntityId: 1, createdAt: -1 });
externalResourceSchema.index({ provider: 1, externalId: 1 });
externalResourceSchema.index({ category: 1, createdAt: -1 });

export const ExternalResourceModel = mongoose.model("ExternalResource", externalResourceSchema);
