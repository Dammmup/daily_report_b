import { Router } from "express";
import { todayIso } from "../../constants.js";
import { AttendanceModel, OfficeLocationModel } from "../../models.js";
import type { Category } from "../../types.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { attendanceSchema, officeLocationSchema } from "../schemas.js";

export const attendanceRouter = Router();

function getWeekStart(date = new Date()) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  copy.setHours(0, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const earthRadius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function serializeAttendance(item: Awaited<ReturnType<typeof AttendanceModel.findOne>>) {
  if (!item) return null;
  const raw = item.toObject();
  return { ...raw, id: item.id, userId: raw.userId.toString() };
}

function serializeOfficeLocation(item: Awaited<ReturnType<typeof OfficeLocationModel.findOne>>) {
  if (!item) return null;
  return { ...item.toObject(), id: item.id };
}

attendanceRouter.get("/summary", auth, async (req: AuthedRequest, res) => {
  if (!req.user!.category) {
    res.json({ officeLocation: null, currentWeekOfficeDays: 0, minWeeklyOfficeDays: 2, requirementMet: false, checkedInToday: false });
    return;
  }

  const officeLocation = await OfficeLocationModel.findOne({ category: req.user!.category });
  const weekStart = getWeekStart();
  const attendance = await AttendanceModel.find({ userId: req.user!._id, date: { $gte: weekStart } }).sort({ date: -1 });
  const verifiedDays = new Set(attendance.filter((item) => item.locationStatus === "verified").map((item) => item.date));
  const minWeeklyOfficeDays = officeLocation?.minWeeklyOfficeDays || 2;

  res.json({
    officeLocation: serializeOfficeLocation(officeLocation),
    currentWeekOfficeDays: verifiedDays.size,
    minWeeklyOfficeDays,
    requirementMet: verifiedDays.size >= minWeeklyOfficeDays,
    checkedInToday: attendance.some((item) => item.date === todayIso()),
    latest: serializeAttendance(attendance[0] || null)
  });
});

attendanceRouter.get("/office-location", auth, async (req: AuthedRequest, res) => {
  if (!req.user!.category) {
    res.json(null);
    return;
  }
  res.json(serializeOfficeLocation(await OfficeLocationModel.findOne({ category: req.user!.category })));
});

attendanceRouter.put("/office-location", auth, async (req: AuthedRequest, res) => {
  if (req.user!.role !== "lead" && req.user!.role !== "admin") {
    res.status(403).json({ message: "Недостаточно прав" });
    return;
  }

  const body = officeLocationSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные координаты офиса" });
    return;
  }

  const category = (req.user!.role === "admin" ? body.data.category : req.user!.category) as Category | undefined;
  if (!category) {
    res.status(400).json({ message: "Сначала выберите департамент" });
    return;
  }

  const location = await OfficeLocationModel.findOneAndUpdate(
    { category },
    {
      category,
      latitude: body.data.latitude,
      longitude: body.data.longitude,
      radiusMeters: body.data.radiusMeters,
      minWeeklyOfficeDays: body.data.minWeeklyOfficeDays,
      updatedBy: req.user!._id
    },
    { upsert: true, new: true }
  );

  res.json(serializeOfficeLocation(location));
});

attendanceRouter.post("/check-in", auth, async (req: AuthedRequest, res) => {
  const body = attendanceSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректное состояние" });
    return;
  }

  const officeLocation = req.user!.category ? await OfficeLocationModel.findOne({ category: req.user!.category }) : null;
  const hasCoordinates = typeof body.data.latitude === "number" && typeof body.data.longitude === "number";
  if (officeLocation && !hasCoordinates) {
    res.status(400).json({ message: "Для офисной отметки нужны координаты устройства" });
    return;
  }

  const point =
    hasCoordinates && typeof body.data.latitude === "number" && typeof body.data.longitude === "number"
      ? { latitude: body.data.latitude, longitude: body.data.longitude }
      : undefined;
  const distance = officeLocation && point ? distanceMeters(point, officeLocation) : undefined;
  const locationStatus = officeLocation ? (distance! <= officeLocation.radiusMeters ? "verified" : "out_of_range") : "unconfigured";
  const existingToday = await AttendanceModel.findOne({ userId: req.user!._id, date: todayIso() });
  const suspiciousReasons = [
    body.data.accuracyMeters && body.data.accuracyMeters > 150 ? `низкая точность GPS: ${Math.round(body.data.accuracyMeters)} м` : "",
    existingToday ? "повторная отметка за день" : "",
    locationStatus === "out_of_range" ? "вне радиуса офиса" : ""
  ].filter(Boolean);

  const attendance = await AttendanceModel.findOneAndUpdate(
    { userId: req.user!._id, date: todayIso() },
    {
      $set: {
        mood: body.data.mood,
        latitude: body.data.latitude,
        longitude: body.data.longitude,
        accuracyMeters: body.data.accuracyMeters,
        distanceMeters: distance,
        officeLatitude: officeLocation?.latitude,
        officeLongitude: officeLocation?.longitude,
        officeRadiusMeters: officeLocation?.radiusMeters,
        locationStatus,
        suspicious: suspiciousReasons.length > 0,
        suspiciousReason: suspiciousReasons.join("; ")
      },
      $setOnInsert: { checkInAt: new Date() }
    },
    { new: true, upsert: true }
  );

  res.status(201).json(serializeAttendance(attendance));
});
