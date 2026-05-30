import { Router } from "express";
import { auth, type AuthedRequest } from "../middleware/auth.js";
import { publicUser } from "../serializers.js";

export const profileRouter = Router();

profileRouter.get("/me", auth, (req: AuthedRequest, res) => {
  res.json({ user: publicUser(req.user!) });
});
