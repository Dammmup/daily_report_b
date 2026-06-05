import { Router } from "express";
import { Types } from "mongoose";
import { decomposeProjectPlan } from "../../ai.js";
import { categories, todayIso } from "../../constants.js";
import { notifyDepartmentPlanChange, sendTelegramRecoveryBroadcast } from "../../telegram.js";
import type { Category } from "../../types.js";
import { PlanModel, UserModel } from "../../models.js";
import { buildAiSummary, buildDashboard, buildDecisionCenter, buildInternAiProfile } from "../../services.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { adminPlanSchema, adminUserUpdateSchema } from "../schemas.js";
import { publicUser, serializePlan, serializeReport } from "../serializers.js";

export const adminRouter = Router();

async function notifyAdminPlanChangeSafely(input: Parameters<typeof notifyDepartmentPlanChange>[0]) {
  try {
    await notifyDepartmentPlanChange(input);
  } catch (error) {
    console.error("Admin plan saved, but Telegram notification failed", error);
  }
}

adminRouter.get("/admin/users", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  const users = await UserModel.find().sort({ role: 1, name: 1 });
  res.json(users.map(publicUser));
});

adminRouter.get("/admin/dashboard", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  const dashboard = await buildDashboard();
  const users = await UserModel.find({ _id: { $in: dashboard.reports.map((report) => report.userId) } });

  res.json({
    ...dashboard,
    reports: dashboard.reports.map((report) => {
      const user = users.find((item) => item.id === report.userId.toString());
      return { ...serializeReport(report), user: user ? publicUser(user) : undefined };
    })
  });
});

adminRouter.get("/admin/ai-summary", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  res.json(await buildAiSummary());
});

adminRouter.get("/admin/decision-center", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  res.json(await buildDecisionCenter());
});

adminRouter.get("/admin/interns/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const profile = await buildInternAiProfile(String(req.params.id));
  if (!profile) {
    res.status(404).json({ message: "Стажер не найден" });
    return;
  }

  res.json({
    ...profile,
    reports: profile.reports.map((report) => serializeReport(report))
  });
});

adminRouter.get("/admin/plans", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  const plans = await PlanModel.find().sort({ category: 1, createdAt: -1 });
  const leads = await UserModel.find({ _id: { $in: plans.map((plan) => plan.leadId) } });

  res.json(
    plans.map((plan) => {
      const lead = leads.find((user) => user.id === plan.leadId.toString());
      return {
        ...serializePlan(plan),
        lead: lead ? publicUser(lead) : undefined
      };
    })
  );
});

adminRouter.post("/admin/telegram/recovery-broadcast", auth, requireRole("admin"), async (_req: AuthedRequest, res, next) => {
  try {
    res.json(await sendTelegramRecoveryBroadcast());
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/admin/plans/preview", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const body = adminPlanSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный план проекта" });
    return;
  }

  const category = body.data.category as Category;
  const startDate = todayIso();
  const steps = await decomposeProjectPlan({
    title: body.data.title,
    milestones: body.data.milestones,
    startDate,
    baseDeadline: body.data.baseDeadline,
    categoryLabel: categories[category]
  });

  res.json({
    startDate,
    adjustedDeadline: body.data.baseDeadline,
    steps: steps.map((step) => ({
      title: step.title,
      description: step.description || "",
      technicalSpec: "",
      technicalInstruction: "",
      deadline: step.deadline,
      assignedTo: "",
      status: "todo",
      source: step.source || "ai"
    }))
  });
});

adminRouter.post("/admin/plans", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const body = adminPlanSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный план проекта" });
    return;
  }

  const category = body.data.category as Category;
  const lead = await UserModel.findOne({ _id: body.data.leadId, role: "lead" });
  if (!lead) {
    res.status(400).json({ message: "Выберите действующего тимлида" });
    return;
  }

  if (lead.category && lead.category !== category) {
    res.status(400).json({ message: "Тимлид уже закреплен за другим департаментом" });
    return;
  }

  if (!lead.category) {
    lead.category = category;
    lead.firstLoginCompleted = true;
    await lead.save();
  }

  const stepAssigneeIds = Array.from(new Set((body.data.steps || []).map((step) => step.assignedTo).filter(Boolean))) as string[];
  if (stepAssigneeIds.some((id) => !Types.ObjectId.isValid(id))) {
    res.status(400).json({ message: "Некорректный исполнитель в шагах плана" });
    return;
  }

  if (stepAssigneeIds.length) {
    const assignees = await UserModel.find({
      _id: { $in: stepAssigneeIds },
      role: { $in: ["intern", "lead"] },
      category
    });
    if (assignees.length !== stepAssigneeIds.length) {
      res.status(400).json({ message: "Исполнители шагов должны быть стажерами или тимлидами выбранного департамента" });
      return;
    }
  }

  const startDate = todayIso();
  const steps = body.data.steps?.length
    ? body.data.steps.map((step) => ({
        title: step.title,
        description: step.description,
        technicalSpec: step.technicalSpec,
        technicalInstruction: step.technicalInstruction,
        deadline: step.deadline,
        assignedTo: step.assignedTo ? step.assignedTo : undefined,
        status: step.status,
        source: step.source
      }))
    : await decomposeProjectPlan({
        title: body.data.title,
        milestones: body.data.milestones,
        startDate,
        baseDeadline: body.data.baseDeadline,
        categoryLabel: categories[category]
      });

  const payload = {
    leadId: lead._id,
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
    aiRationale: "AI разложил утвержденный администратором план на шаги. Тимлид может уточнить ТЗ, инструкции и назначить исполнителей."
  };

  const plan = await PlanModel.create(payload);

  if (!plan) {
    res.status(500).json({ message: "Не удалось сохранить план" });
    return;
  }

  await notifyAdminPlanChangeSafely({
    planId: plan.id,
    category,
    actorId: req.user!.id,
    type: "plan_created",
    title: "План создан администратором",
    summary: `Администратор назначил тимлида ${lead.name} и создал план "${plan.title}". Дедлайн: ${plan.adjustedDeadline}. Шагов: ${plan.steps.length}.`
  });

  const serialized = serializePlan(plan);
  res.status(201).json({ ...serialized, lead: publicUser(lead) });
});

adminRouter.delete("/admin/plans/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const plan = await PlanModel.findById(req.params.id);
  if (!plan) {
    res.status(404).json({ message: "План не найден" });
    return;
  }

  await PlanModel.deleteOne({ _id: plan._id });
  res.json({ ok: true });
});

adminRouter.patch("/admin/users/:id", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const body = adminUserUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные данные пользователя" });
    return;
  }

  if (req.params.id === req.user!.id && body.data.role && body.data.role !== "admin") {
    res.status(400).json({ message: "Нельзя снять роль администратора с самого себя" });
    return;
  }

  const user = await UserModel.findById(req.params.id);
  if (!user) {
    res.status(404).json({ message: "Пользователь не найден" });
    return;
  }

  if (body.data.role) {
    user.role = body.data.role;
    if (body.data.role !== "intern") user.firstLoginCompleted = true;
  }

  if ("category" in body.data) {
    if (body.data.category === null) {
      user.category = undefined;
    } else {
      user.category = body.data.category;
    }
  }

  if (user.role === "intern" && !user.firstLoginCompleted) {
    user.firstLoginCompleted = false;
  }

  await user.save();
  res.json({ user: publicUser(user) });
});

adminRouter.delete("/admin/users/:id/plan", auth, requireRole("admin"), async (req: AuthedRequest, res) => {
  const user = await UserModel.findById(req.params.id);
  if (!user?.category) {
    res.status(404).json({ message: "У пользователя нет департамента с планом" });
    return;
  }

  await PlanModel.deleteOne({ category: user.category });
  res.json({ ok: true });
});
