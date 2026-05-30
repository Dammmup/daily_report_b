import { Router } from "express";
import { categories } from "../../constants.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) => {
  res.json({ ok: true, storage: "mongodb" });
});

systemRouter.get("/categories", (_req, res) => {
  res.json(categories);
});
