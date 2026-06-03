import { put } from "@vercel/blob";
import { Router } from "express";
import { z } from "zod";
import { AuditLogModel } from "../../models.js";
import { auth, type AuthedRequest } from "../middleware/auth.js";

export const uploadRouter = Router();

const allowedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip"
]);

const uploadSchema = z.object({
  filename: z.string().min(1).max(180),
  contentType: z.string().min(3).max(120),
  data: z.string().min(1),
  scope: z.enum(["avatar", "artifact"]).default("artifact")
});

function safeFilename(filename: string) {
  const cleaned = filename.replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-");
  return cleaned.slice(-120) || "upload.bin";
}

uploadRouter.post("/uploads", auth, async (req: AuthedRequest, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ message: "Vercel Blob token is not configured. Add BLOB_READ_WRITE_TOKEN in Vercel env." });
    return;
  }

  const body = uploadSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный файл" });
    return;
  }

  if (!allowedTypes.has(body.data.contentType)) {
    res.status(400).json({ message: "Этот тип файла не поддерживается" });
    return;
  }

  const buffer = Buffer.from(body.data.data, "base64");
  const maxBytes = body.data.scope === "avatar" ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
  if (!buffer.length || buffer.length > maxBytes) {
    res.status(400).json({ message: `Файл должен быть не больше ${Math.round(maxBytes / 1024 / 1024)} МБ` });
    return;
  }

  const pathname = `${body.data.scope}/${req.user!.id}/${Date.now()}-${safeFilename(body.data.filename)}`;
  const blob = await put(pathname, buffer, {
    access: "public",
    contentType: body.data.contentType
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: `${body.data.scope}_uploaded`,
    entityType: body.data.scope,
    entityId: blob.pathname,
    category: req.user!.category,
    message: `Загружен файл ${body.data.filename}`
  });

  res.status(201).json({ url: blob.url, pathname: blob.pathname, contentType: body.data.contentType });
});
