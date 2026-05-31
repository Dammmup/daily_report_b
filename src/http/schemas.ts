import { z } from "zod";

export const categorySchema = z.enum(["data-system-ml", "marketing-sales", "erp-development", "data-security"]);

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
  mood: z.enum(["focused", "normal", "blocked"])
});

export const reportSchema = z.object({
  yesterday: z.string().min(10),
  todayPlan: z.string().min(10),
  blockers: z.string().default("")
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

export const departmentSchema = z.object({
  category: categorySchema
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

export const assistantPlanFitSchema = z.object({
  question: z.string().min(5).max(1200),
  planId: z.string().optional()
});
