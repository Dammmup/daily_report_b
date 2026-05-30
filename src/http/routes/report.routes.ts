import { Router } from "express";
import { ReportModel, UserModel } from "../../models.js";
import { createDailyReport } from "../../services.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { reportSchema } from "../schemas.js";
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
