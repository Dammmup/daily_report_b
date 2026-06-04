import { Router } from "express";
import { buildPlanFitAssistant } from "../../services.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { assistantPlanFitSchema } from "../schemas.js";

export const assistantRouter = Router();

assistantRouter.post("/assistant/plan-fit", auth, async (req: AuthedRequest, res, next) => {
  if (req.user!.role !== "lead" && req.user!.role !== "admin") {
    res.status(403).json({ message: "AI-ассистент доступен только тимлиду и администратору" });
    return;
  }

  const body = assistantPlanFitSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Задайте вопрос по плану проекта" });
    return;
  }

  try {
    res.json(
      await buildPlanFitAssistant({
        requester: req.user!,
        question: body.data.question,
        planId: body.data.planId,
        stepId: body.data.stepId
      })
    );
  } catch (error) {
    next(error);
  }
});
