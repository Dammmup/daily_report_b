import { Router } from "express";
import { Types } from "mongoose";
import { decomposeProjectPlan } from "../../ai.js";
import { categories, todayIso } from "../../constants.js";
import { AuditLogModel, PlanModel, StepArtifactModel, StepCommentModel, UserModel } from "../../models.js";
import { notifyDepartmentPlanChange } from "../../telegram.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { planSchema, planStepCreateSchema, planStepUpdateSchema, stepArtifactSchema, stepCommentSchema } from "../schemas.js";
import { publicUser, serializePlan } from "../serializers.js";

export const planRouter = Router();
const activePlanStatuses = ["draft", "approved"] as const;

function activePlanQuery(category: Category | string) {
  return { category, status: { $in: activePlanStatuses } } as any;
}

async function notifyPlanChangeSafely(input: Parameters<typeof notifyDepartmentPlanChange>[0]) {
  try {
    await notifyDepartmentPlanChange(input);
  } catch (error) {
    console.error("Plan saved, but Telegram plan notification failed", error);
  }
}

planRouter.get("/my-plan", auth, async (req: AuthedRequest, res) => {
  if (!req.user!.category) {
    res.json(null);
    return;
  }

  const plan = await PlanModel.findOne(activePlanQuery(req.user!.category)).sort({ createdAt: -1 });
  res.json(serializePlan(plan));
});

planRouter.get("/department-plans", auth, async (req: AuthedRequest, res) => {
  if (!req.user!.category) {
    res.json([]);
    return;
  }
  const plans = await PlanModel.find({ category: req.user!.category }).sort({ createdAt: -1 });
  res.json(plans.map(serializePlan));
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
  const existing = await PlanModel.findOne(activePlanQuery(category)).sort({ createdAt: -1 });
  const startDate = existing?.startDate || todayIso();
  const steps = await decomposeProjectPlan({
    title: body.data.title,
    milestones: body.data.milestones,
    startDate,
    baseDeadline: body.data.baseDeadline,
    categoryLabel: categories[category]
  });

  const payload = {
      leadId: req.user!._id,
      title: body.data.title,
      category,
      version: existing?.version || (await PlanModel.countDocuments({ category })) + 1,
      status: "approved" as const,
      startDate,
      baseDeadline: body.data.baseDeadline,
      adjustedDeadline: existing?.adjustedDeadline || body.data.baseDeadline,
      milestones: body.data.milestones,
      steps,
      issues: existing?.issues || [],
      aiRationale: "AI разложил утвержденный план на шаги. Блокеры из дэйликов стажеров могут продлить дедлайн."
    };

  const plan = existing
    ? await PlanModel.findByIdAndUpdate(existing._id, payload, { returnDocument: "after" })
    : await PlanModel.create(payload);

  if (!plan) {
    res.status(500).json({ message: "Не удалось сохранить план" });
    return;
  }

  await notifyPlanChangeSafely({
    planId: plan.id,
    category,
    actorId: req.user!.id,
    type: existing ? "plan_updated" : "plan_created",
    title: existing ? "План обновлен" : "План создан",
    summary: `Тимлид обновил план "${plan.title}". Текущий дедлайн: ${plan.adjustedDeadline}. Шагов в плане: ${plan.steps.length}.`
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: existing ? "plan_updated" : "plan_created",
    entityType: "plan",
    entityId: plan.id,
    category,
    message: `${existing ? "Обновлен" : "Создан"} план "${plan.title}"`
  });

  res.status(201).json(serializePlan(plan));
});

planRouter.post("/department-plan/:planId/complete", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const plan = req.user!.category ? await PlanModel.findOne({ _id: req.params.planId, category: req.user!.category }) : null;
  if (!plan) {
    res.status(404).json({ message: "План не найден" });
    return;
  }

  plan.status = "completed";
  plan.completedAt = new Date();
  await plan.save();

  await notifyPlanChangeSafely({
    planId: plan.id,
    category: plan.category as Category,
    actorId: req.user!.id,
    type: "plan_updated",
    title: "План завершен",
    summary: `Тимлид завершил план "${plan.title}". Новый план департамента можно создать отдельно.`
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "plan_completed",
    entityType: "plan",
    entityId: plan.id,
    category: plan.category,
    message: `Завершен план "${plan.title}"`
  });

  res.json(serializePlan(plan));
});

planRouter.post("/department-plan/steps", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const body = planStepCreateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный шаг плана" });
    return;
  }

  const plan = req.user!.category ? await PlanModel.findOne(activePlanQuery(req.user!.category)).sort({ createdAt: -1 }) : null;
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
    technicalSpec: body.data.technicalSpec,
    technicalInstruction: body.data.technicalInstruction,
    deadline: body.data.deadline,
    assignedTo: body.data.assignedTo ? new Types.ObjectId(body.data.assignedTo) : undefined,
    status: "todo",
    source: "manual"
  });
  await plan.save();
  const addedStep = plan.steps[plan.steps.length - 1];
  await notifyPlanChangeSafely({
    planId: plan.id,
    category: plan.category as Category,
    actorId: req.user!.id,
    type: body.data.assignedTo ? "step_assigned" : "step_added",
    title: body.data.assignedTo ? "Назначен новый шаг" : "Добавлен новый шаг",
    summary: `Шаг: ${addedStep.title}. Дедлайн: ${addedStep.deadline}.${body.data.assignedTo ? " Шаг назначен стажеру." : ""}`,
    stepId: addedStep._id.toString()
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: body.data.assignedTo ? "step_assigned" : "step_added",
    entityType: "plan_step",
    entityId: addedStep._id.toString(),
    category: plan.category,
    message: `Добавлен шаг "${addedStep.title}"`
  });
  res.status(201).json(serializePlan(plan));
});

planRouter.patch("/department-plan/steps/:stepId", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const body = planStepUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректное обновление шага" });
    return;
  }

  const plan =
    req.user!.role === "admin"
      ? await PlanModel.findOne({ "steps._id": req.params.stepId } as any).sort({ createdAt: -1 })
      : req.user!.category
        ? await PlanModel.findOne(activePlanQuery(req.user!.category)).sort({ createdAt: -1 })
        : null;
  const step = plan?.steps.id(String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг плана не найден" });
    return;
  }

  const before = {
    title: step.title,
    deadline: step.deadline,
    assignedTo: step.assignedTo?.toString(),
    status: step.status
  };

  if (body.data.assignedTo) {
    const assignee = await UserModel.findOne({ _id: body.data.assignedTo, role: "intern", category: plan.category });
    if (!assignee) {
      res.status(400).json({ message: "Стажер должен быть из департамента плана" });
      return;
    }
  }

  if (body.data.title !== undefined) step.title = body.data.title;
  if (body.data.description !== undefined) step.description = body.data.description;
  if (body.data.technicalSpec !== undefined) step.technicalSpec = body.data.technicalSpec;
  if (body.data.technicalInstruction !== undefined) step.technicalInstruction = body.data.technicalInstruction;
  if (body.data.deadline !== undefined) step.deadline = body.data.deadline;
  if (body.data.status !== undefined) step.status = body.data.status;
  if (body.data.assignedTo !== undefined) {
    step.assignedTo = body.data.assignedTo ? new Types.ObjectId(body.data.assignedTo) : undefined;
  }

  await plan.save();
  const changes = [
    before.title !== step.title ? `название: "${before.title}" -> "${step.title}"` : "",
    before.deadline !== step.deadline ? `дедлайн: ${before.deadline} -> ${step.deadline}` : "",
    before.assignedTo !== step.assignedTo?.toString() ? "назначение изменено" : "",
    before.status !== step.status ? `статус: ${before.status} -> ${step.status}` : ""
  ].filter(Boolean);

  await notifyPlanChangeSafely({
    planId: plan.id,
    category: plan.category as Category,
    actorId: req.user!.id,
    type: before.deadline !== step.deadline ? "deadline_changed" : before.assignedTo !== step.assignedTo?.toString() ? "step_assigned" : "step_updated",
    title: before.deadline !== step.deadline ? "Изменен дедлайн шага" : "Изменен шаг плана",
    summary: `Шаг: ${step.title}. ${changes.join("; ") || "Обновлены параметры шага."}`,
    stepId: step._id.toString()
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "step_updated",
    entityType: "plan_step",
    entityId: step._id.toString(),
    category: plan.category,
    message: `Обновлен шаг "${step.title}"`,
    meta: { changes }
  });
  res.json(serializePlan(plan));
});

async function findVisiblePlanStep(req: AuthedRequest, stepId: string) {
  const query = req.user!.role === "admin" ? {} : req.user!.category ? { category: req.user!.category } : null;
  if (!query) return { plan: null, step: null };
  const plan = await PlanModel.findOne({ ...query, "steps._id": stepId } as any);
  const step = plan?.steps.id(stepId) || null;
  return { plan, step };
}

planRouter.get("/department-plan/steps/:stepId/thread", auth, async (req: AuthedRequest, res) => {
  const { plan, step } = await findVisiblePlanStep(req, String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг не найден" });
    return;
  }

  const [comments, artifacts] = await Promise.all([
    StepCommentModel.find({ stepId: step._id }).sort({ createdAt: 1 }),
    StepArtifactModel.find({ stepId: step._id }).sort({ createdAt: -1 })
  ]);
  const users = await UserModel.find({ _id: { $in: [...comments.map((item) => item.userId), ...artifacts.map((item) => item.userId)] } });

  res.json({
    comments: comments.map((comment) => ({
      ...comment.toObject(),
      id: comment.id,
      userId: comment.userId.toString(),
      user: users.find((user) => user.id === comment.userId.toString()) ? publicUser(users.find((user) => user.id === comment.userId.toString())!) : undefined,
      createdAt: comment.createdAt.toISOString()
    })),
    artifacts: artifacts.map((artifact) => ({
      ...artifact.toObject(),
      id: artifact.id,
      userId: artifact.userId.toString(),
      user: users.find((user) => user.id === artifact.userId.toString()) ? publicUser(users.find((user) => user.id === artifact.userId.toString())!) : undefined,
      createdAt: artifact.createdAt.toISOString()
    }))
  });
});

planRouter.post("/department-plan/steps/:stepId/comments", auth, async (req: AuthedRequest, res) => {
  const body = stepCommentSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Введите комментарий" });
    return;
  }

  const { plan, step } = await findVisiblePlanStep(req, String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг не найден" });
    return;
  }

  if (req.user!.role === "intern" && step.assignedTo?.toString() !== req.user!.id) {
    res.status(403).json({ message: "Комментировать можно только назначенный вам шаг" });
    return;
  }

  const comment = await StepCommentModel.create({ planId: plan._id, stepId: step._id, userId: req.user!._id, text: body.data.text });
  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "step_commented",
    entityType: "plan_step",
    entityId: step._id.toString(),
    category: plan.category,
    message: `Добавлен комментарий к шагу "${step.title}"`
  });
  res.status(201).json({ ...comment.toObject(), id: comment.id, userId: comment.userId.toString(), user: publicUser(req.user!), createdAt: comment.createdAt.toISOString() });
});

planRouter.post("/department-plan/steps/:stepId/artifacts", auth, async (req: AuthedRequest, res) => {
  const body = stepArtifactSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Укажите название и корректную ссылку" });
    return;
  }

  const { plan, step } = await findVisiblePlanStep(req, String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг не найден" });
    return;
  }

  if (req.user!.role === "intern" && step.assignedTo?.toString() !== req.user!.id) {
    res.status(403).json({ message: "Артефакт можно прикрепить только к назначенному вам шагу" });
    return;
  }

  const artifact = await StepArtifactModel.create({ planId: plan._id, stepId: step._id, userId: req.user!._id, title: body.data.title, url: body.data.url });
  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "step_artifact_added",
    entityType: "plan_step",
    entityId: step._id.toString(),
    category: plan.category,
    message: `Добавлен артефакт к шагу "${step.title}"`
  });
  res.status(201).json({ ...artifact.toObject(), id: artifact.id, userId: artifact.userId.toString(), user: publicUser(req.user!), createdAt: artifact.createdAt.toISOString() });
});
