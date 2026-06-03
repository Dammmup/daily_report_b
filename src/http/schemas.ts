import { z } from "zod";
import { categoryValues } from "../constants.js";

export const categorySchema = z.enum(categoryValues);

export const requestCodeSchema = z
  .object({
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().min(5).optional().or(z.literal("")),
    password: z.string().min(4),
    name: z.string().min(2)
  })
  .refine((data) => data.email || data.phone, {
    message: "Необходимо указать Email или номер телефона",
    path: ["email"]
  });

export const verifyEmailSchema = z
  .object({
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().min(5).optional().or(z.literal("")),
    code: z.string().min(6).max(6)
  })
  .refine((data) => data.email || data.phone, {
    message: "Необходимо указать Email или номер телефона"
  });

export const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(4)
});

export const attendanceSchema = z.object({
  mood: z.enum(["focused", "normal", "blocked"]),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyMeters: z.number().min(0).max(10000).optional()
});

export const officeLocationSchema = z.object({
  category: categorySchema.optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().min(25).max(2000).default(150),
  minWeeklyOfficeDays: z.number().int().min(1).max(7).default(2)
});

export const reportSchema = z.object({
  yesterday: z.string().min(10),
  todayPlan: z.string().min(10),
  blockers: z.string().default(""),
  linkedStepIds: z.array(z.string()).default([])
});

export const surveySchema = z.object({
  traits: z.array(z.string()).min(1),
  skills: z.string().min(5),
  experience: z.string().min(2),
  learningStyle: z.string().min(3),
  goal: z.string().min(5)
});

export const planSchema = z.object({
  title: z.string().min(5),
  baseDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  milestones: z.array(z.string()).min(2)
});

export const adminPlanSchema = planSchema.extend({
  category: categorySchema,
  leadId: z.string().min(1),
  steps: z
    .array(
      z.object({
        title: z.string().min(3),
        description: z.string().default(""),
        technicalSpec: z.string().max(3000).default(""),
        technicalInstruction: z.string().max(3000).default(""),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        assignedTo: z.string().optional().or(z.literal("")),
        status: z.enum(["todo", "in_progress", "done", "canceled"]).default("todo"),
        source: z.enum(["ai", "manual"]).default("manual")
      })
    )
    .optional()
});

export const planStepCreateSchema = z.object({
  title: z.string().min(3),
  description: z.string().default(""),
  technicalSpec: z.string().max(3000).default(""),
  technicalInstruction: z.string().max(3000).default(""),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assignedTo: z.string().optional().or(z.literal(""))
});

export const planStepUpdateSchema = z.object({
  title: z.string().min(3).optional(),
  description: z.string().optional(),
  technicalSpec: z.string().max(3000).optional(),
  technicalInstruction: z.string().max(3000).optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  assignedTo: z.string().optional().nullable(),
  status: z.enum(["todo", "in_progress", "done", "canceled"]).optional()
});

export const departmentSchema = z.object({
  category: categorySchema,
  reason: z.string().min(10).max(700).optional()
});

export const adminUserUpdateSchema = z.object({
  role: z.enum(["intern", "lead", "admin"]).optional(),
  category: categorySchema.nullable().optional()
});

export const telegramDigestSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  content: z.enum(["productivity", "reports", "full"])
});

export const telegramMiniAppSessionSchema = z.object({
  initData: z.string().min(20)
});

export const assistantPlanFitSchema = z.object({
  question: z.string().min(5).max(1200),
  planId: z.string().optional()
});

export const profileUpdateSchema = z.object({
  name: z.string().min(2).max(120),
  avatarColor: z.string().min(4).max(32).optional(),
  avatarUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(500).optional()
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(4),
  newPassword: z.string().min(4)
});

export const stepCommentSchema = z.object({
  text: z.string().min(1).max(1000)
});

export const stepArtifactSchema = z.object({
  title: z.string().min(2).max(160),
  url: z.string().url()
});

export const reportUpdateSchema = z.object({
  yesterday: z.string().min(10),
  todayPlan: z.string().min(10),
  blockers: z.string().default(""),
  linkedStepIds: z.array(z.string()).default([])
});
