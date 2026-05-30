import { Router } from "express";
import { todayIso } from "../../constants.js";
import { AttendanceModel } from "../../models.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { attendanceSchema } from "../schemas.js";

export const attendanceRouter = Router();

attendanceRouter.post("/check-in", auth, async (req: AuthedRequest, res) => {
  const body = attendanceSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректное состояние" });
    return;
  }

  const attendance = await AttendanceModel.findOneAndUpdate(
    { userId: req.user!._id, date: todayIso() },
    { $set: { mood: body.data.mood }, $setOnInsert: { checkInAt: new Date() } },
    { new: true, upsert: true }
  );

  res.status(201).json({ ...attendance.toObject(), id: attendance.id, userId: attendance.userId.toString() });
});
