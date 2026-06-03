import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

const integrationConnectionSchema = new Schema(
  {
    provider: { type: String, enum: ["google_drive", "trello", "notion"], required: true, index: true },
    connectedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    category: { type: String, enum: categoryValues, required: false, index: true },
    status: { type: String, enum: ["configured", "needs_reauth", "disabled"], default: "configured", index: true },
    externalAccountId: { type: String, default: "" },
    externalAccountName: { type: String, default: "" },
    accessTokenEncrypted: { type: String, default: "" },
    refreshTokenEncrypted: { type: String, default: "" },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date },
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

integrationConnectionSchema.index({ provider: 1, connectedByUserId: 1, category: 1 });

export const IntegrationConnectionModel = mongoose.model("IntegrationConnection", integrationConnectionSchema);
