import cors from "cors";
import express from "express";
import { errorHandler } from "./http/middleware/error-handler.js";
import { apiRouter } from "./http/routes/index.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", apiRouter);
  app.use(errorHandler);

  return app;
}
