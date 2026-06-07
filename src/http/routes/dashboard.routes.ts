import { Router } from "express";
import { todayIso } from "../../constants.js";
import { AuditLogModel, AttendanceModel, PlanModel, ReportModel, UserModel } from "../../models.js";
import { buildAiSummary, buildDashboard, buildDecisionCenter, buildInternAiProfile, formatLeadSummary } from "../../services.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { publicUser, serializeReport } from "../serializers.js";

export const dashboardRouter = Router();

function escapeCsv(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function userScope(req: AuthedRequest) {
  return req.user!.role === "admin" ? undefined : (req.user?.category as Category | undefined);
}

dashboardRouter.get("/dashboard", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const dashboard = await buildDashboard(req.user?.category as Category | undefined);
  const users = await UserModel.find({ _id: { $in: dashboard.reports.map((report) => report.userId) } });

  res.json({
    ...dashboard,
    reports: dashboard.reports.map((report) => {
      const user = users.find((item) => item.id === report.userId.toString());
      return { ...serializeReport(report), user: user ? publicUser(user) : undefined };
    })
  });
});

dashboardRouter.get("/ai-summary", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  res.json(await buildAiSummary(req.user?.category as Category | undefined));
});

dashboardRouter.get("/decision-center", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  if (!req.user?.category) {
    res.status(400).json({ message: "Сначала выберите департамент" });
    return;
  }
  res.json(await buildDecisionCenter(req.user?.category as Category | undefined));
});

dashboardRouter.get("/interns/:id", auth, requireRole("lead"), async (req: AuthedRequest, res) => {
  const profile = await buildInternAiProfile(String(req.params.id));
  if (!profile) {
    res.status(404).json({ message: "Стажер не найден" });
    return;
  }

  if (req.user?.category && profile.user.category !== req.user.category) {
    res.status(403).json({ message: "Стажер относится к другому департаменту" });
    return;
  }

  res.json({
    ...profile,
    reports: profile.reports.map((report) => serializeReport(report))
  });
});

dashboardRouter.get("/risk-center", auth, async (req: AuthedRequest, res) => {
  if (req.user!.role !== "lead" && req.user!.role !== "admin") {
    res.status(403).json({ message: "Недостаточно прав" });
    return;
  }

  const category = userScope(req);
  const dashboard = await buildDashboard(category);
  const today = todayIso();
  const plans = await PlanModel.find({ ...(category ? { category } : {}), status: { $in: ["draft", "approved"] } } as any);
  const overdueSteps = plans.flatMap((plan) =>
    plan.steps
      .filter((step) => step.deadline < today && step.status !== "done" && step.status !== "canceled")
      .map((step) => ({
        planId: plan.id,
        planTitle: plan.title,
        stepId: step._id.toString(),
        title: step.title,
        deadline: step.deadline,
        assignedTo: step.assignedTo?.toString()
      }))
  );
  const missingReports = dashboard.interns.filter((intern) => !dashboard.reports.some((report) => report.userId.toString() === intern.id && report.date === today));
  const weakInterns = dashboard.interns.filter((intern) => intern.averageScore > 0 && intern.averageScore < 65);
  const officeIssues = dashboard.interns.filter((intern) => (intern.officeAttendanceCount || 0) === 0);

  res.json({ overdueSteps, missingReports, weakInterns, officeIssues });
});

dashboardRouter.get("/weekly-review", auth, async (req: AuthedRequest, res) => {
  if (req.user!.role !== "lead" && req.user!.role !== "admin") {
    res.status(403).json({ message: "Недостаточно прав" });
    return;
  }
  res.json({ summary: await formatLeadSummary(userScope(req), "full") });
});

dashboardRouter.get("/export.csv", auth, async (req: AuthedRequest, res) => {
  if (req.user!.role !== "lead" && req.user!.role !== "admin") {
    res.status(403).send("Forbidden");
    return;
  }

  const category = userScope(req);
  const users = await UserModel.find({ role: "intern", ...(category ? { category } : {}) }).sort({ name: 1 });
  const reports = await ReportModel.find({ userId: { $in: users.map((user) => user._id) } });
  const attendance = await AttendanceModel.find({ userId: { $in: users.map((user) => user._id) } });
  const rows = [
    ["name", "email", "department", "reports", "avg_score", "attendance", "office_verified"].map(escapeCsv).join(","),
    ...users.map((user) => {
      const userReports = reports.filter((report) => report.userId.toString() === user.id);
      const scores = userReports.map((report) => report.aiReview?.productivityScore || 0);
      const userAttendance = attendance.filter((item) => item.userId.toString() === user.id);
      const avg = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
      return [
        user.name,
        user.email,
        user.category,
        userReports.length,
        avg,
        userAttendance.length,
        userAttendance.filter((item) => item.locationStatus === "verified").length
      ].map(escapeCsv).join(",");
    })
  ];

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "export_csv",
    entityType: "report",
    category,
    message: "Выгружен CSV-отчет"
  });

  res.header("Content-Type", "text/csv; charset=utf-8");
  res.header("Content-Disposition", "attachment; filename=dailyreport-export.csv");
  res.send(`\uFEFF${rows.join("\n")}`);
});

dashboardRouter.get("/audit-log", auth, requireRole("admin"), async (_req: AuthedRequest, res) => {
  const logs = await AuditLogModel.find().sort({ createdAt: -1 }).limit(100);
  const users = await UserModel.find({ _id: { $in: logs.map((log) => log.actorId) } });
  res.json(
    logs.map((log) => ({
      ...log.toObject(),
      id: log.id,
      actorId: log.actorId.toString(),
      actor: users.find((user) => user.id === log.actorId.toString()) ? publicUser(users.find((user) => user.id === log.actorId.toString())!) : undefined,
      createdAt: log.createdAt.toISOString()
    }))
  );
});
