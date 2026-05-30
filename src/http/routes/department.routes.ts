import { Router } from "express";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { departmentSchema } from "../schemas.js";
import { publicUser } from "../serializers.js";

export const departmentRouter = Router();

departmentRouter.post("/department", auth, async (req: AuthedRequest, res) => {
  const body = departmentSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Выберите корректный департамент" });
    return;
  }

  if (req.user!.category) {
    res.status(409).json({ message: "Департамент уже выбран. Изменить его может только администратор." });
    return;
  }

  req.user!.category = body.data.category;
  await req.user!.save();
  res.json({ user: publicUser(req.user!) });
});
