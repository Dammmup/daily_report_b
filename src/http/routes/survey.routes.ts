import { Router } from "express";
import { analyzeSurvey } from "../../ai.js";
import { SurveyModel } from "../../models.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { surveySchema } from "../schemas.js";

export const surveyRouter = Router();

surveyRouter.post("/survey", auth, async (req: AuthedRequest, res) => {
  const body = surveySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Заполните опрос полностью" });
    return;
  }

  const analysis = await analyzeSurvey(body.data);
  const survey = await SurveyModel.findOneAndUpdate(
    { userId: req.user!._id },
    { answers: body.data, analysis },
    { new: true, upsert: true }
  );

  req.user!.firstLoginCompleted = true;
  await req.user!.save();
  res.status(201).json({ ...survey.toObject(), id: survey.id, userId: survey.userId.toString() });
});
