import { Router } from "express";
import { UserModel } from "../../models.js";
import { buildAiSummary, buildDashboard, buildInternAiProfile } from "../../services.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { publicUser, serializeReport } from "../serializers.js";

export const dashboardRouter = Router();

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
