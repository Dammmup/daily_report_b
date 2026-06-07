import { Router } from "express";
import { Types } from "mongoose";
import { decomposeProjectPlan } from "../../ai.js";
import { categories, todayIso } from "../../constants.js";
import { AuditLogModel, PlanModel, StepArtifactModel, StepCommentModel, UserModel } from "../../models.js";
import { notifyDepartmentPlanChange } from "../../telegram.js";
import type { Category } from "../../types.js";
import { buildAssignmentDraft } from "../../services.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { assignmentApplySchema, planBulkAssignSchema, planSchema, planStepCreateSchema, planStepUpdateSchema, stepArtifactSchema, stepCommentSchema } from "../schemas.js";
import { serializePlan, userForViewer } from "../serializers.js";

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

async function findManageablePlan(req: AuthedRequest, planId: string) {
  if (req.user!.role === "admin") return PlanModel.findById(planId);
  if (!req.user!.category) return null;
  return PlanModel.findOne({ _id: planId, category: req.user!.category });
}

async function findPlanAssignee(userId: string, category: Category | string) {
  if (!Types.ObjectId.isValid(userId)) return null;
  return UserModel.findOne({ _id: new Types.ObjectId(userId), role: { $in: ["intern", "lead"] }, category: category as Category });
}

function assigneeRoleLabel(role: string) {
  return role === "lead" ? "тимлиду" : "стажеру";
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
  const startDate = todayIso();
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
      version: (await PlanModel.countDocuments({ category })) + 1,
      status: "approved" as const,
      startDate,
      baseDeadline: body.data.baseDeadline,
      adjustedDeadline: body.data.baseDeadline,
      milestones: body.data.milestones,
      steps,
      issues: [],
      aiRationale: "AI разложил утвержденный план на шаги. Блокеры из дэйликов стажеров могут продлить дедлайн."
    };

  const plan = await PlanModel.create(payload);

  if (!plan) {
    res.status(500).json({ message: "Не удалось сохранить план" });
    return;
  }

  await notifyPlanChangeSafely({
    planId: plan.id,
    category,
    actorId: req.user!.id,
    type: "plan_created",
    title: "План создан",
    summary: `Тимлид создал план "${plan.title}". Текущий дедлайн: ${plan.adjustedDeadline}. Шагов в плане: ${plan.steps.length}.`
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "plan_created",
    entityType: "plan",
    entityId: plan.id,
    category,
    message: `Создан план "${plan.title}"`
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

planRouter.post("/department-plan/:planId/assignment-draft", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const draft = await buildAssignmentDraft({
    requester: req.user!,
    planId: String(req.params.planId)
  });

  if (!draft.plan) {
    res.status(404).json({ message: "План не найден или недоступен" });
    return;
  }

  res.json(draft);
});

planRouter.post("/department-plan/:planId/assignments/apply", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const body = assignmentApplySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный список назначений" });
    return;
  }

  const plan = await findManageablePlan(req, String(req.params.planId));
  if (!plan) {
    res.status(404).json({ message: "План не найден или недоступен" });
    return;
  }

  if (plan.status === "completed" || plan.status === "archived") {
    res.status(400).json({ message: "Нельзя назначать шаги в завершенном или архивном плане" });
    return;
  }

  const uniqueAssignments = Array.from(
    new Map(body.data.assignments.map((assignment) => [assignment.stepId, assignment])).values()
  );
  const assignees = await UserModel.find({
    _id: { $in: uniqueAssignments.map((assignment) => assignment.userId) },
    role: "intern",
    category: plan.category
  });
  const assigneeById = new Map(assignees.map((user) => [user.id, user]));

  const applied: { stepId: string; stepTitle: string; userId: string; userName: string }[] = [];
  const skipped: { stepId: string; reason: string }[] = [];

  for (const assignment of uniqueAssignments) {
    const step = plan.steps.id(assignment.stepId);
    if (!step) {
      skipped.push({ stepId: assignment.stepId, reason: "Шаг не найден" });
      continue;
    }
    if (step.status === "done" || step.status === "canceled") {
      skipped.push({ stepId: assignment.stepId, reason: "Шаг уже закрыт" });
      continue;
    }
    if (step.assignedTo) {
      skipped.push({ stepId: assignment.stepId, reason: "Шаг уже назначен" });
      continue;
    }

    const assignee = assigneeById.get(assignment.userId);
    if (!assignee) {
      skipped.push({ stepId: assignment.stepId, reason: "Стажер не найден в департаменте плана" });
      continue;
    }

    step.assignedTo = new Types.ObjectId(assignee.id);
    applied.push({
      stepId: step._id.toString(),
      stepTitle: step.title,
      userId: assignee.id,
      userName: assignee.name
    });
  }

  if (!applied.length) {
    res.status(400).json({ message: "Нет назначений, которые можно применить", skipped });
    return;
  }

  await plan.save();

  await notifyPlanChangeSafely({
    planId: plan.id,
    category: plan.category as Category,
    actorId: req.user!.id,
    type: "step_assigned",
    title: "AI распределил шаги плана",
    summary: `AI-PM предложил и ${req.user!.role === "admin" ? "администратор" : "тимлид"} подтвердил назначения: ${applied
      .map((item) => `${item.stepTitle} -> ${item.userName}`)
      .join("; ")}.`,
    stepId: applied[0]?.stepId
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "ai_assignments_applied",
    entityType: "plan",
    entityId: plan.id,
    category: plan.category,
    message: `AI-распределение применено для плана "${plan.title}"`,
    meta: { applied, skipped }
  });

  res.json({
    plan: serializePlan(plan),
    applied,
    skipped
  });
});

planRouter.post("/department-plan/:planId/assign-all", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const body = planBulkAssignSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный исполнитель плана" });
    return;
  }

  const plan = await findManageablePlan(req, String(req.params.planId));
  if (!plan) {
    res.status(404).json({ message: "План не найден или недоступен" });
    return;
  }

  if (plan.status === "completed" || plan.status === "archived") {
    res.status(400).json({ message: "Нельзя назначать завершенный или архивный план" });
    return;
  }

  if (!plan.steps.length) {
    res.status(400).json({ message: "В плане пока нет шагов для назначения" });
    return;
  }

  const assignee = await findPlanAssignee(body.data.assignedTo, plan.category);
  if (!assignee) {
    res.status(400).json({ message: "Исполнитель должен быть стажером или тимлидом из департамента плана" });
    return;
  }

  const beforeAssignedTo = plan.steps.map((step) => ({ stepId: step._id.toString(), assignedTo: step.assignedTo?.toString() }));
  const assigneeId = assignee._id.toString();
  const assignedTo = new Types.ObjectId(assigneeId);
  plan.steps.forEach((step) => {
    step.assignedTo = assignedTo;
  });
  await plan.save();

  await notifyPlanChangeSafely({
    planId: plan.id,
    category: plan.category as Category,
    actorId: req.user!.id,
    type: "step_assigned",
    title: "План назначен одному исполнителю",
    summary: `Все ${plan.steps.length} шагов плана "${plan.title}" назначены ${assigneeRoleLabel(assignee.role)} ${assignee.name}.`,
    stepId: plan.steps[0]?._id.toString()
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "plan_assigned",
    entityType: "plan",
    entityId: plan.id,
    category: plan.category,
    message: `План "${plan.title}" полностью назначен ${assignee.name}`,
    meta: { assignedTo: assigneeId, assignedRole: assignee.role, steps: plan.steps.length, beforeAssignedTo }
  });

  res.json(serializePlan(plan));
});

planRouter.post(["/department-plan/steps", "/department-plan/:planId/steps"], auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const body = planStepCreateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный шаг плана" });
    return;
  }

  const plan = req.params.planId
    ? req.user!.category
      ? await PlanModel.findOne({ _id: req.params.planId, ...activePlanQuery(req.user!.category) } as any)
      : null
    : req.user!.category
      ? await PlanModel.findOne(activePlanQuery(req.user!.category)).sort({ createdAt: -1 })
      : null;
  if (!plan) {
    res.status(404).json({ message: "Сначала создайте план департамента" });
    return;
  }

  if (body.data.assignedTo) {
    const assignee = await findPlanAssignee(body.data.assignedTo, plan.category);
    if (!assignee) {
      res.status(400).json({ message: "Исполнитель должен быть стажером или тимлидом из вашего департамента" });
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
    summary: `Шаг: ${addedStep.title}. Дедлайн: ${addedStep.deadline}.${body.data.assignedTo ? " Шаг назначен исполнителю." : ""}`,
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
        ? await PlanModel.findOne({ ...activePlanQuery(req.user!.category), "steps._id": req.params.stepId } as any).sort({ createdAt: -1 })
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
    const assignee = await findPlanAssignee(body.data.assignedTo, plan.category);
    if (!assignee) {
      res.status(400).json({ message: "Исполнитель должен быть стажером или тимлидом из департамента плана" });
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

planRouter.post("/department-plan/steps/:stepId/claim", auth, requireRole("intern"), async (req: AuthedRequest, res) => {
  if (!req.user!.category) {
    res.status(400).json({ message: "Сначала выберите департамент" });
    return;
  }

  const plan = await PlanModel.findOne({ ...activePlanQuery(req.user!.category), "steps._id": req.params.stepId } as any).sort({ createdAt: -1 });
  const step = plan?.steps.id(String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг не найден" });
    return;
  }

  if (step.status === "done" || step.status === "canceled") {
    res.status(400).json({ message: "Этот шаг уже закрыт" });
    return;
  }

  if (step.assignedTo && step.assignedTo.toString() !== req.user!.id) {
    res.status(409).json({ message: "Шаг уже назначен другому стажеру" });
    return;
  }

  step.assignedTo = req.user!._id as any;
  if (step.status === "todo") step.status = "in_progress";
  await plan.save();

  await notifyPlanChangeSafely({
    planId: plan.id,
    category: plan.category as Category,
    actorId: req.user!.id,
    type: "step_assigned",
    title: "Стажер взял шаг в работу",
    summary: `${req.user!.name} взял(а) шаг "${step.title}" по плану "${plan.title}". Дедлайн: ${step.deadline}.`,
    stepId: step._id.toString()
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "step_claimed",
    entityType: "plan_step",
    entityId: step._id.toString(),
    category: plan.category,
    message: `Стажер взял шаг "${step.title}" в плане "${plan.title}"`
  });

  res.json(serializePlan(plan));
});

planRouter.patch("/department-plan/steps/:stepId/my-status", auth, requireRole("intern"), async (req: AuthedRequest, res) => {
  const status = String(req.body?.status || "");
  if (!["todo", "in_progress", "done", "canceled"].includes(status)) {
    res.status(400).json({ message: "Некорректный статус шага" });
    return;
  }

  if (!req.user!.category) {
    res.status(400).json({ message: "Сначала выберите департамент" });
    return;
  }

  const plan = await PlanModel.findOne({ ...activePlanQuery(req.user!.category), "steps._id": req.params.stepId } as any).sort({ createdAt: -1 });
  const step = plan?.steps.id(String(req.params.stepId));
  if (!plan || !step) {
    res.status(404).json({ message: "Шаг не найден" });
    return;
  }

  if (step.assignedTo?.toString() !== req.user!.id) {
    res.status(403).json({ message: "Можно менять статус только своего шага" });
    return;
  }

  step.status = status as any;
  await plan.save();

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "step_status_updated",
    entityType: "plan_step",
    entityId: step._id.toString(),
    category: plan.category,
    message: `Стажер обновил статус шага "${step.title}": ${status}`
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
  const userById = new Map(users.map((user) => [user.id, user]));
  const viewer = { id: req.user!.id, role: req.user!.role };

  res.json({
    comments: comments.map((comment) => ({
      ...comment.toObject(),
      id: comment.id,
      userId: comment.userId.toString(),
      user: userById.has(comment.userId.toString()) ? userForViewer(userById.get(comment.userId.toString())!, viewer) : undefined,
      createdAt: comment.createdAt.toISOString()
    })),
    artifacts: artifacts.map((artifact) => ({
      ...artifact.toObject(),
      id: artifact.id,
      userId: artifact.userId.toString(),
      user: userById.has(artifact.userId.toString()) ? userForViewer(userById.get(artifact.userId.toString())!, viewer) : undefined,
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
  res.status(201).json({
    ...comment.toObject(),
    id: comment.id,
    userId: comment.userId.toString(),
    user: userForViewer(req.user!, { id: req.user!.id, role: req.user!.role }),
    createdAt: comment.createdAt.toISOString()
  });
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
  res.status(201).json({
    ...artifact.toObject(),
    id: artifact.id,
    userId: artifact.userId.toString(),
    user: userForViewer(req.user!, { id: req.user!.id, role: req.user!.role }),
    createdAt: artifact.createdAt.toISOString()
  });
});
