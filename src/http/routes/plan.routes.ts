import { Router } from "express";
import { Types } from "mongoose";
import { decomposeProjectPlan } from "../../ai.js";
import { categories, todayIso } from "../../constants.js";
import { PlanModel, UserModel } from "../../models.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { planSchema, planStepCreateSchema, planStepUpdateSchema } from "../schemas.js";
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

  const category = req.user!.category as Category;
  const existing = await PlanModel.findOne({ category });
  const startDate = existing?.startDate || todayIso();
  const steps = await decomposeProjectPlan({
    title: body.data.title,
    milestones: body.data.milestones,
    startDate,
    baseDeadline: body.data.baseDeadline,
    categoryLabel: categories[category]
  });

  const plan = await PlanModel.findOneAndUpdate(
    { category },
    {
      leadId: req.user!._id,
      title: body.data.title,
      category,
      status: "approved",
      startDate,
      baseDeadline: body.data.baseDeadline,
      adjustedDeadline: existing?.adjustedDeadline || body.data.baseDeadline,
      milestones: body.data.milestones,
      steps,
      issues: existing?.issues || [],
      aiRationale: "AI разложил утвержденный план на шаги. Блокеры из дэйликов стажеров могут продлить дедлайн."
    },
    { new: true, upsert: true }
  );

  res.status(201).json(serializePlan(plan));
});

planRouter.post("/department-plan/steps", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const body = planStepCreateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный шаг плана" });
    return;
  }

  const plan = req.user!.category ? await PlanModel.findOne({ category: req.user!.category }) : null;
  if (!plan) {
    res.status(404).json({ message: "Сначала создайте план департамента" });
    return;
  }

  if (body.data.assignedTo) {
    const assignee = await UserModel.findOne({ _id: body.data.assignedTo, role: "intern", category: req.user!.category });
    if (!assignee) {
      res.status(400).json({ message: "Стажер должен быть из вашего департамента" });
      return;
    }
  }

  plan.steps.push({
    title: body.data.title,
    description: body.data.description,
    deadline: body.data.deadline,
    assignedTo: body.data.assignedTo ? new Types.ObjectId(body.data.assignedTo) : undefined,
    status: "todo",
    source: "manual"
  });
  await plan.save();
  res.status(201).json(serializePlan(plan));
});

planRouter.patch("/department-plan/steps/:stepId", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const body = planStepUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректное обновление шага" });
    return;
  }

  const plan = req.user!.category ? await PlanModel.findOne({ category: req.user!.category }) : null;
  const step = plan?.steps.id(String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг плана не найден" });
    return;
  }

  if (body.data.assignedTo) {
    const assignee = await UserModel.findOne({ _id: body.data.assignedTo, role: "intern", category: req.user!.category });
    if (!assignee) {
      res.status(400).json({ message: "Стажер должен быть из вашего департамента" });
      return;
    }
  }

  if (body.data.title !== undefined) step.title = body.data.title;
  if (body.data.description !== undefined) step.description = body.data.description;
  if (body.data.deadline !== undefined) step.deadline = body.data.deadline;
  if (body.data.status !== undefined) step.status = body.data.status;
  if (body.data.assignedTo !== undefined) {
    step.assignedTo = body.data.assignedTo ? new Types.ObjectId(body.data.assignedTo) : undefined;
  }

  await plan.save();
  res.json(serializePlan(plan));
});
