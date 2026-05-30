import mongoose, { Schema } from "mongoose";

const attendanceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    date: { type: String, required: true, index: true },
    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date },
    mood: { type: String, enum: ["focused", "normal", "blocked"], required: true }
  },
  { timestamps: true }
);

attendanceSchema.index({ userId: 1, date: 1 }, { unique: true });

export const AttendanceModel = mongoose.model("Attendance", attendanceSchema);
