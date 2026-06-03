import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

const departmentChangeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    fromCategory: { type: String, enum: categoryValues, required: false },
    toCategory: { type: String, enum: categoryValues, required: true },
    reason: { type: String, required: true },
    changedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

departmentChangeSchema.index({ userId: 1, changedAt: -1 });

export const DepartmentChangeModel = mongoose.model("DepartmentChange", departmentChangeSchema);
