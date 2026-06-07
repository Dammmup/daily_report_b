import mongoose, { Schema } from "mongoose";

const authThrottleSchema = new Schema(
  {
    keyHash: { type: String, required: true, unique: true, index: true },
    attempts: { type: Number, default: 0 },
    windowStartedAt: { type: Date, required: true },
    blockedUntil: { type: Date },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

authThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthThrottleModel = mongoose.model("AuthThrottle", authThrottleSchema);
