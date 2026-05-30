import { categories } from "../constants.js";
import type { PlanModel, ReportModel, UserDocument } from "../models.js";
import type { Category } from "../types.js";

type ReportDocument = NonNullable<Awaited<ReturnType<typeof ReportModel.findOne>>>;
type PlanDocument = NonNullable<Awaited<ReturnType<typeof PlanModel.findOne>>>;

export function publicUser(user: UserDocument) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    category: user.category,
    categoryLabel: user.category ? categories[user.category as Category] : undefined,
    avatarColor: user.avatarColor,
    firstLoginCompleted: user.firstLoginCompleted,
    emailVerified: user.emailVerified,
    telegramLinked: Boolean(user.telegramChatId),
    telegramDigestEnabled: user.telegramDigestEnabled,
    telegramDigestTime: user.telegramDigestTime,
    telegramDigestContent: user.telegramDigestContent,
    lastActiveAt: user.lastActiveAt.toISOString()
  };
}

export function serializeReport(report: ReportDocument | null) {
  if (!report) return null;
  const item = report.toObject();
  return {
    ...item,
    id: report.id,
    userId: item.userId.toString(),
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString()
  };
}

export function serializePlan(plan: PlanDocument | null) {
  if (!plan) return null;
  const item = plan.toObject();
  return {
    ...item,
    id: plan.id,
    leadId: item.leadId?.toString(),
    issues: item.issues.map((issue) => ({ ...issue, id: issue._id.toString() }))
  };
}
