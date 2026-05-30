import mongoose, { Schema } from "mongoose";

const verificationCodeSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date }
  },
  { timestamps: true }
);

verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const VerificationCodeModel = mongoose.model("VerificationCode", verificationCodeSchema);
