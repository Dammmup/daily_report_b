import cors from "cors";
import express from "express";
import { errorHandler } from "./http/middleware/error-handler.js";
import { apiRouter } from "./http/routes/index.js";

export function configuredAllowedOrigins() {
  const configured = [process.env.ALLOWED_ORIGINS, process.env.FRONTEND_URL]
    .filter(Boolean)
    .flatMap((value) => value!.split(","))
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://daily-report-f.vercel.app",
    ...configured
  ]);
}

export function isOriginAllowed(origin: string | undefined, origins = configuredAllowedOrigins()) {
  return !origin || origins.has(origin.replace(/\/$/, ""));
}

export function createApp() {
  const app = express();
  const origins = configuredAllowedOrigins();

  app.set("trust proxy", 1);
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (isOriginAllowed(origin, origins)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin is not allowed"));
      }
    })
  );
  app.use(express.json({ limit: "10mb" }));
  app.get("/", (_req, res) => {
    res.json({ ok: true, service: "dailyreport-api", health: "/api/health" });
  });
  app.use("/api", apiRouter);
  app.use(errorHandler);

  return app;
}
