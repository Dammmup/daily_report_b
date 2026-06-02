import { Router } from "express";
import { Types } from "mongoose";
import { AuditLogModel, PlanModel, ReportModel, UserModel } from "../../models.js";
import { createDailyReport } from "../../services.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { reportSchema, reportUpdateSchema } from "../schemas.js";
import { publicUser, serializeReport } from "../serializers.js";

export const reportRouter = Router();

reportRouter.get("/reports", auth, async (req: AuthedRequest, res) => {
  const reports = await ReportModel.find({ userId: req.user!._id }).sort({ createdAt: -1 });
  const users = await UserModel.find({ _id: { $in: reports.map((report) => report.userId) } });
  const result = reports.map((report) => {
    const user = users.find((item) => item.id === report.userId.toString());
    return { ...serializeReport(report), user: user ? publicUser(user) : undefined };
  });

  res.json(result);
});

reportRouter.patch("/reports/:id", auth, async (req: AuthedRequest, res) => {
  const body = reportUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Заполните отчет подробнее" });
    return;
  }

  const report = await ReportModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!report) {
    res.status(404).json({ message: "Отчет не найден" });
    return;
  }

  if (report.date !== new Date().toISOString().slice(0, 10)) {
    res.status(403).json({ message: "Редактировать можно только сегодняшний дэйлик" });
    return;
  }

  const plan = req.user!.category ? await PlanModel.findOne({ category: req.user!.category, status: { $in: ["draft", "approved"] } } as any).sort({ createdAt: -1 }) : null;
  const linkedStepIds = plan
    ? body.data.linkedStepIds.filter((stepId) => {
        const step = plan.steps.id(stepId);
        return Boolean(step && step.assignedTo?.toString() === req.user!.id);
      })
    : [];

  report.yesterday = body.data.yesterday;
  report.todayPlan = body.data.todayPlan;
  report.blockers = body.data.blockers;
  report.linkedStepIds = linkedStepIds.map((id) => new Types.ObjectId(id)) as any;
  await report.save();

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "report_updated",
    entityType: "report",
    entityId: report.id,
    category: req.user!.category,
    message: "Пользователь отредактировал сегодняшний дэйлик"
  });

  res.json(serializeReport(report));
});

reportRouter.post("/reports", auth, async (req: AuthedRequest, res, next) => {
  const body = reportSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Заполните отчет подробнее" });
    return;
  }

  try {
    const report = await createDailyReport({ userId: req.user!._id, ...body.data, source: "web" });
    res.status(201).json(serializeReport(report));
  } catch (error) {
    next(error);
  }
});
