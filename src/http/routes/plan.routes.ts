import { Router } from "express";
import { todayIso } from "../../constants.js";
import { PlanModel } from "../../models.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { planSchema } from "../schemas.js";
import { serializePlan } from "../serializers.js";

export const planRouter = Router();

planRouter.get("/my-plan", auth, async (req: AuthedRequest, res) => {
  if (!req.user!.category) {
    res.json(null);
    return;
  }

  const plan = await PlanModel.findOne({ category: req.user!.category });
  res.json(serializePlan(plan));
});

planRouter.post("/department-plan", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const body = planSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный план проекта" });
    return;
  }

  if (!req.user!.category) {
    res.status(400).json({ message: "Сначала выберите свой департамент" });
    return;
  }

  const existing = await PlanModel.findOne({ category: req.user!.category });
  const plan = await PlanModel.findOneAndUpdate(
    { category: req.user!.category },
    {
      leadId: req.user!._id,
      title: body.data.title,
      category: req.user!.category as Category,
      status: "approved",
      startDate: existing?.startDate || todayIso(),
      baseDeadline: body.data.baseDeadline,
      adjustedDeadline: existing?.adjustedDeadline || body.data.baseDeadline,
      milestones: body.data.milestones,
      issues: existing?.issues || [],
      aiRationale: existing?.aiRationale || "План утвержден тимлидом департамента. Блокеры из дэйликов могут продлить дедлайн."
    },
    { new: true, upsert: true }
  );

  res.status(201).json(serializePlan(plan));
});
