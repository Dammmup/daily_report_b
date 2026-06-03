import mongoose, { Schema } from "mongoose";
import { categoryValues } from "../constants.js";

const officeLocationSchema = new Schema(
  {
    category: {
      type: String,
      enum: categoryValues,
      required: true,
      unique: true,
      index: true
    },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    radiusMeters: { type: Number, default: 150 },
    minWeeklyOfficeDays: { type: Number, default: 2 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const OfficeLocationModel = mongoose.model("OfficeLocation", officeLocationSchema);
