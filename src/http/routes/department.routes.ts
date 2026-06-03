import { Router } from "express";
import { AuditLogModel, DepartmentChangeModel } from "../../models.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { departmentSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const departmentRouter = Router();

departmentRouter.post("/department", auth, async (req: AuthedRequest, res) => {
  const body = departmentSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Выберите корректный департамент" });
    return;
  }

  if (!req.user!.category) {
    req.user!.category = body.data.category;
    await req.user!.save();
    res.json({ user: publicUser(req.user!) });
    return;
  }

  if (req.user!.role !== "intern") {
    res.status(409).json({ message: "Департамент уже выбран. Изменить его может только администратор." });
    return;
  }

  if (req.user!.category === body.data.category) {
    res.json({ user: publicUser(req.user!) });
    return;
  }

  if (!body.data.reason?.trim()) {
    res.status(400).json({ message: "Для смены департамента нужно объяснить причину" });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (req.user!.lastDepartmentChangedAt?.toISOString().slice(0, 10) === today) {
    res.status(429).json({ message: "Стажер может менять департамент только один раз в день" });
    return;
  }

  const fromCategory = req.user!.category;
  req.user!.category = body.data.category;
  req.user!.lastDepartmentChangedAt = new Date();
  req.user!.lastDepartmentChangeReason = body.data.reason.trim();
  await req.user!.save();

  await DepartmentChangeModel.create({
    userId: req.user!._id,
    fromCategory,
    toCategory: body.data.category,
    reason: body.data.reason.trim(),
    changedAt: req.user!.lastDepartmentChangedAt
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "department_changed",
    entityType: "user",
    entityId: req.user!.id,
    category: body.data.category,
    message: `Стажер сменил департамент: ${fromCategory} -> ${body.data.category}`,
    meta: { fromCategory, toCategory: body.data.category, reason: body.data.reason.trim() }
  });

  res.json({ user: publicUser(req.user!) });
});
