import { categories } from "../constants.js";
import type { PlanModel, ReportModel, UserDocument } from "../models.js";
import type { Category } from "../types.js";

type ReportDocument = NonNullable<Awaited<ReturnType<typeof ReportModel.findOne>>>;
type PlanDocument = NonNullable<Awaited<ReturnType<typeof PlanModel.findOne>>>;

function isStepOverdue(step: { deadline: string; status: string }) {
  const today = new Date().toISOString().slice(0, 10);
  return step.deadline < today && step.status !== "done" && step.status !== "canceled";
}

export function publicUser(user: UserDocument) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    category: user.category || undefined,
    categoryLabel: user.category ? categories[user.category as Category] : undefined,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    firstLoginCompleted: user.firstLoginCompleted,
    emailVerified: user.emailVerified,
    telegramLinked: Boolean(user.telegramChatId),
    telegramDigestEnabled: user.telegramDigestEnabled,
    telegramDigestTime: user.telegramDigestTime,
    telegramDigestContent: user.telegramDigestContent,
    telegramUsername: user.telegramUsername,
    telegramActivityMessages: user.telegramActivityMessages,
    telegramActivityScore: user.telegramActivityScore,
    telegramActivitySummary: user.telegramActivitySummary,
    lastDepartmentChangedAt: user.lastDepartmentChangedAt?.toISOString(),
    lastDepartmentChangeReason: user.lastDepartmentChangeReason,
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
    linkedStepIds: (item.linkedStepIds || []).map((stepId) => stepId.toString()),
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
    steps: (item.steps || []).map((step) => ({
      ...step,
      id: step._id.toString(),
      assignedTo: step.assignedTo?.toString(),
      overdue: isStepOverdue(step)
    })),
    issues: item.issues.map((issue) => ({ ...issue, id: issue._id.toString() })),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString()
  };
}
