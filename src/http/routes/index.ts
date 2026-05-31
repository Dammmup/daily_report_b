import { Router } from "express";
import { attendanceRouter } from "./attendance.routes.js";
import { adminRouter } from "./admin.routes.js";
import { assistantRouter } from "./assistant.routes.js";
import { authRouter } from "./auth.routes.js";
import { dashboardRouter } from "./dashboard.routes.js";
import { departmentRouter } from "./department.routes.js";
import { planRouter } from "./plan.routes.js";
import { profileRouter } from "./profile.routes.js";
import { reportRouter } from "./report.routes.js";
import { surveyRouter } from "./survey.routes.js";
import { systemRouter } from "./system.routes.js";
import { telegramRouter } from "./telegram.routes.js";

export const apiRouter = Router();

apiRouter.use(systemRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use(adminRouter);
apiRouter.use(assistantRouter);
apiRouter.use("/attendance", attendanceRouter);
apiRouter.use(profileRouter);
apiRouter.use(departmentRouter);
apiRouter.use(reportRouter);
apiRouter.use(dashboardRouter);
apiRouter.use(surveyRouter);
apiRouter.use(planRouter);
apiRouter.use(telegramRouter);
