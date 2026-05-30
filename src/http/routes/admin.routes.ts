import { Router } from "express";
import { PlanModel, UserModel } from "../../models.js";
import { buildAiSummary, buildDashboard, buildInternAiProfile } from "../../services.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { adminUserUpdateSchema } from "../schemas.js";
import { publicUser, serializePlan, serializeReport } from "../serializers.js";

export const adminRouter = Router();

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
  const plans = await PlanModel.find().sort({ category: 1 });
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
