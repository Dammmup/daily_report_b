import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String },
    category: {
      type: String,
      enum: categoryValues,
      required: false,
      index: true
    },
    message: { type: String, required: true },
    meta: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

export const AuditLogModel = mongoose.model("AuditLog", auditLogSchema);
