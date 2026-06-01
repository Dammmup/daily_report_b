import mongoose, { Schema } from "mongoose";

const officeLocationSchema = new Schema(
  {
    category: {
      type: String,
      enum: ["data-system-ml", "marketing-sales", "erp-development", "data-security"],
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
