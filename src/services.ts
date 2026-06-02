import type { Types } from "mongoose";
import { askGroqAssistant, reviewReport } from "./ai.js";
import { addDays, categories, todayIso } from "./constants.js";
import { AttendanceModel, PlanModel, ReportModel, SurveyModel, UserModel, type UserDocument } from "./models.js";
import type { Category, DecisionCenter, PlanFitCandidate } from "./types.js";

const activePlanFilter = { status: { $in: ["draft", "approved"] as const } } as any;

function isPlanStepOverdue(step: { deadline: string; status: string }) {
  return step.deadline < todayIso() && step.status !== "done" && step.status !== "canceled";
}

function buildPlanProgress(plan?: Awaited<ReturnType<typeof PlanModel.findOne>> | null) {
  const steps = plan?.steps || [];
  const total = steps.length;
  const done = steps.filter((step) => step.status === "done").length;
  const inProgress = steps.filter((step) => step.status === "in_progress").length;
  const todo = steps.filter((step) => step.status === "todo").length;
  const canceled = steps.filter((step) => step.status === "canceled").length;
  const overdue = steps.filter(isPlanStepOverdue).length;
  const unassigned = steps.filter((step) => !step.assignedTo).length;

  return {
    total,
    done,
    inProgress,
    todo,
    canceled,
    overdue,
    unassigned,
    completionPercent: total ? Math.round((done / total) * 100) : 0
  };
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
    firstLoginCompleted: user.firstLoginCompleted,
    emailVerified: user.emailVerified,
    telegramLinked: Boolean(user.telegramChatId),
    lastActiveAt: user.lastActiveAt.toISOString()
  };
}

export async function createDailyReport(input: {
  userId: Types.ObjectId | string;
  yesterday: string;
  todayPlan: string;
  blockers: string;
  linkedStepIds?: string[];
  source: "web" | "telegram";
}) {
  const user = await UserModel.findById(input.userId);
  if (!user?.category) {
    throw new Error("Сначала выберите департамент. Дэйлики пишутся по плану выбранного департамента.");
  }

  const existingToday = await ReportModel.findOne({ userId: input.userId, date: todayIso() });
  if (existingToday) {
    throw new Error("Дэйлик за сегодня уже отправлен. Если нужно исправить отчет, обратитесь к тимлиду.");
  }

  const aiReview = await reviewReport(input);
  const now = new Date();
  const plan = await PlanModel.findOne({ category: user.category, ...activePlanFilter }).sort({ createdAt: -1 });
  const linkedStepIds =
    user.role === "intern" && plan
      ? (input.linkedStepIds || []).filter((stepId) => {
          const step = plan.steps.id(stepId);
          return Boolean(step && step.assignedTo?.toString() === user.id);
        })
      : [];

  const report = await ReportModel.create({
    userId: input.userId,
    date: todayIso(),
    yesterday: input.yesterday,
    todayPlan: input.todayPlan,
    blockers: input.blockers,
    linkedStepIds,
    source: input.source,
    status: now.getHours() >= 10 ? "late" : "submitted",
    aiReview
  });

  if (user.role === "intern" && plan && aiReview.deadlineImpactDays > 0) {
    plan.adjustedDeadline = addDays(plan.adjustedDeadline, aiReview.deadlineImpactDays);
    plan.aiRationale = `AI продлил срок на ${aiReview.deadlineImpactDays} дн. из-за блокера в дэйлике стажера.`;
    await plan.save();
  }

  return report;
}

export async function buildDashboard(category?: Category) {
  const [users, attendance, reports, surveys, plans] = await Promise.all([
    UserModel.find().sort({ name: 1 }),
    AttendanceModel.find(),
    ReportModel.find().sort({ createdAt: -1 }),
    SurveyModel.find(),
    PlanModel.find()
  ]);

  const interns = users.filter((user) => user.role === "intern" && (!category || user.category === category));
  const internIds = new Set(interns.map((user) => user.id));
  const scopedReports = reports.filter((report) => internIds.has(report.userId.toString()));
  const reportScores = scopedReports
    .map((report) => report.aiReview?.productivityScore)
    .filter((score): score is number => typeof score === "number");
  const averageScore = reportScores.length ? Math.round(reportScores.reduce((sum, score) => sum + score, 0) / reportScores.length) : 0;

  const byCategory = Object.entries(categories)
    .filter(([key]) => !category || key === category)
    .map(([key, label]) => {
      const categoryInterns = interns.filter((user) => user.category === key);
      const categoryReports = scopedReports.filter((report) => categoryInterns.some((user) => user.id === report.userId.toString()));

      return {
        key,
        label,
        interns: categoryInterns.length,
        reports: categoryReports.length,
        averageScore: Math.round(
          categoryReports.reduce((sum, report) => sum + (report.aiReview?.productivityScore || 0), 0) / Math.max(categoryReports.length, 1)
        )
      };
    });

  const internRows = interns.map((user) => {
    const userReports = scopedReports.filter((report) => report.userId.toString() === user.id);
    const scores = userReports.map((report) => report.aiReview?.productivityScore || 0);
    const survey = surveys.find((item) => item.userId.toString() === user.id);
    const plan = plans
      .filter((item) => item.category === user.category && ["draft", "approved"].includes(item.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const userAttendance = attendance.filter((item) => item.userId.toString() === user.id);
    const officeAttendanceCount = userAttendance.filter((item) => item.locationStatus === "verified").length;

    return {
      ...publicUser(user),
      attendanceCount: userAttendance.length,
      officeAttendanceCount,
      reportsCount: userReports.length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
      activeToday: attendance.some((item) => item.userId.toString() === user.id && item.date === todayIso()),
      survey,
      plan,
      assignedOpenSteps: plan?.steps.filter((step) => step.assignedTo?.toString() === user.id && step.status !== "done" && step.status !== "canceled").length || 0
    };
  });

  const activePlans = plans.filter((plan) => ["draft", "approved"].includes(plan.status) && (!category || plan.category === category));

  return {
    stats: {
      internsTotal: interns.length,
      checkedInToday: attendance.filter((item) => internIds.has(item.userId.toString()) && item.date === todayIso()).length,
      reportsTotal: scopedReports.length,
      aiReviewedReports: scopedReports.filter((report) => report.aiReview).length,
      averageScore,
      byCategory,
      plans: activePlans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        category: plan.category,
        categoryLabel: categories[plan.category as Category],
        adjustedDeadline: plan.adjustedDeadline,
        progress: buildPlanProgress(plan)
      }))
    },
    interns: internRows,
    reports: scopedReports
  };
}

export async function buildInternAiProfile(userId: string) {
  const [user, reports, survey, attendance] = await Promise.all([
    UserModel.findById(userId),
    ReportModel.find({ userId }).sort({ createdAt: -1 }),
    SurveyModel.findOne({ userId }),
    AttendanceModel.find({ userId }).sort({ createdAt: -1 })
  ]);

  if (!user || user.role !== "intern") return null;

  const plan = user.category ? await PlanModel.findOne({ category: user.category, ...activePlanFilter }).sort({ createdAt: -1 }) : null;
  const scores = reports.map((report) => report.aiReview?.productivityScore || 0);
  const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  const blockerReports = reports.filter((report) => report.blockers.trim().length > 0);
  const aiReviewedReports = reports.filter((report) => report.aiReview);

  return {
    user: publicUser(user),
    survey,
    plan,
    attendance,
    reports,
    stats: {
      reportsCount: reports.length,
      aiReviewedReports: aiReviewedReports.length,
      averageScore,
      attendanceCount: attendance.length,
      officeAttendanceCount: attendance.filter((item) => item.locationStatus === "verified").length,
      currentWeekOfficeDays: new Set(
        attendance
          .filter((item) => item.locationStatus === "verified" && item.date >= todayIso().slice(0, 8) + "01")
          .map((item) => item.date)
      ).size,
      blockerReports: blockerReports.length,
      lastReportAt: reports[0]?.createdAt?.toISOString()
    }
  };
}

export async function buildAiSummary(category?: Category) {
  const dashboard = await buildDashboard(category);
  const profiles = await Promise.all(dashboard.interns.map((intern) => buildInternAiProfile(intern.id)));

  const interns = profiles
    .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))
    .filter((profile) => !category || profile.user.category === category)
    .map((profile) => {
      const latestReport = profile.reports[0];
      return {
        user: profile.user,
        stats: profile.stats,
        surveyAnalysis: profile.survey?.analysis,
        latestReportAi: latestReport?.aiReview,
        latestReportDate: latestReport?.date,
        plan: profile.plan
      };
    });

  const needsAttention = interns.filter(
    (intern) => intern.stats.averageScore > 0 && (intern.stats.averageScore < 65 || intern.stats.blockerReports > 0)
  );

  return {
    overview: {
      averageScore: dashboard.stats.averageScore,
      aiReviewedReports: dashboard.stats.aiReviewedReports,
      internsWithSurvey: interns.filter((intern) => Boolean(intern.surveyAnalysis)).length,
      needsAttention: needsAttention.length
    },
    interns
  };
}

export async function formatLeadSummary(category?: Category, content: "productivity" | "reports" | "full" = "full") {
  const dashboard = await buildDashboard(category);
  const aiSummary = await buildAiSummary(category);
  const weak = dashboard.interns
    .filter((intern) => intern.averageScore > 0 && intern.averageScore < 65)
    .map((intern) => `${intern.name}: ${intern.averageScore}%`)
    .join(", ");

  const header = category ? `Сводка по департаменту: ${categories[category]}` : "Сводка по всем стажерам";
  const productivity = [
    header,
    `Средняя продуктивность: ${dashboard.stats.averageScore}%`,
    weak ? `Зона внимания: ${weak}` : "Зона внимания: критичных просадок нет",
    `Вывод: ${dashboard.stats.averageScore >= 70 ? "день выглядит продуктивным" : "дню нужна дополнительная проверка"}`
  ];

  const reports = [
    `Всего стажеров: ${dashboard.stats.internsTotal}`,
    `Отметились сегодня: ${dashboard.stats.checkedInToday}`,
    `Отчетов: ${dashboard.stats.reportsTotal}`,
    `AI обработал отчетов: ${dashboard.stats.aiReviewedReports}`,
    `Опросов с AI-профилем: ${aiSummary.overview.internsWithSurvey}`
  ];

  if (content === "productivity") return productivity.join("\n");
  if (content === "reports") return [header, ...reports].join("\n");
  return [...productivity, ...reports].join("\n");
}

function textOf(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (!value) return "";
  if (Array.isArray(value)) return value.join(" ");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const maybeDocument = value as { toObject?: (options?: unknown) => Record<string, unknown> };
    const plain = typeof maybeDocument.toObject === "function"
      ? maybeDocument.toObject({ depopulate: true, flattenMaps: true, versionKey: false })
      : (value as Record<string, unknown>);

    const allowed = Object.fromEntries(
      Object.entries(plain).filter(([key]) => !key.startsWith("_") && !["schema", "$__", "$isNew", "db", "collection"].includes(key))
    );
    return Object.values(allowed).map((item) => textOf(item, depth + 1)).join(" ");
  }
  return String(value);
}

function scoreCandidate(planText: string, surveyText: string, averageScore: number, sameDepartment: boolean) {
  const planWords = new Set(
    planText
      .toLowerCase()
      .split(/[^a-zа-я0-9+#]+/i)
      .filter((word) => word.length > 3)
  );
  const surveyWords = new Set(
    surveyText
      .toLowerCase()
      .split(/[^a-zа-я0-9+#]+/i)
      .filter((word) => word.length > 3)
  );
  const overlaps = [...planWords].filter((word) => surveyWords.has(word)).length;
  return Math.min(100, Math.round(overlaps * 12 + averageScore * 0.35 + (sameDepartment ? 18 : 0)));
}

export async function buildPlanFitAssistant(input: {
  requester: UserDocument;
  question: string;
  planId?: string;
}) {
  const plan =
    input.planId && input.requester.role === "admin"
      ? await PlanModel.findById(input.planId)
      : input.requester.category
        ? await PlanModel.findOne({ category: input.requester.category, ...activePlanFilter }).sort({ createdAt: -1 })
        : null;

  if (!plan) {
    return {
      answer: "План проекта не найден. Тимлиду нужно сначала создать план департамента, а админу выбрать существующий план.",
      plan: null,
      candidates: [],
      fallbackUsed: false
    };
  }

  const [interns, surveys, reports] = await Promise.all([
    UserModel.find({ role: "intern" }).sort({ name: 1 }),
    SurveyModel.find(),
    ReportModel.find().sort({ createdAt: -1 })
  ]);

  const planText = `${plan.title} ${plan.milestones.join(" ")} ${plan.aiRationale}`;
  const rows = interns.map((user) => {
    const survey = surveys.find((item) => item.userId.toString() === user.id);
    const userReports = reports.filter((report) => report.userId.toString() === user.id);
    const scores = userReports.map((report) => report.aiReview?.productivityScore || 0);
    const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
    const sameDepartment = user.category === plan.category;
    const surveyText = `${textOf(survey?.answers)} ${textOf(survey?.analysis)}`;
    const score = scoreCandidate(planText, surveyText, averageScore, sameDepartment);

    return {
      user,
      survey,
      score,
      averageScore,
      reportsCount: userReports.length,
      sameDepartment
    };
  });

  const primary = rows.filter((row) => row.sameDepartment && row.survey).sort((a, b) => b.score - a.score);
  const fallback = rows.filter((row) => !row.sameDepartment && row.survey).sort((a, b) => b.score - a.score);
  const finalRows = (primary.length ? primary : fallback.length ? fallback : rows.sort((a, b) => b.score - a.score)).slice(0, 5);
  const fallbackUsed = !primary.length && finalRows.some((row) => !row.sameDepartment);

  const candidates: PlanFitCandidate[] = finalRows.map((row) => {
    const analysis = row.survey?.analysis;
    const strengths = analysis?.strengths?.slice(0, 3).join(", ");
    const skills = analysis?.skillsSummary || "AI-сводка навыков отсутствует";
    const risks = [
      ...(analysis?.weaknesses?.slice(0, 2) || []),
      row.reportsCount ? "" : "нет истории дэйликов для проверки темпа"
    ].filter(Boolean);

    return {
      user: publicUser(row.user),
      score: row.score,
      matchReason: strengths
        ? `Совпадает с планом по профилю: ${strengths}. ${skills}`
        : `Подбор сделан по продуктивности и доступным данным. ${skills}`,
      risks,
      source: row.sameDepartment ? "same_department" : "other_department",
      surveyAnalysis: analysis,
      averageScore: row.averageScore,
      reportsCount: row.reportsCount
    };
  });

  const context = candidates
    .map((candidate) =>
      [
        `Имя: ${candidate.user.name}`,
        `Департамент: ${candidate.user.categoryLabel || candidate.user.category || "не выбран"}`,
        `Скор: ${candidate.score}`,
        `Средняя продуктивность: ${candidate.averageScore}%`,
        `AI-профиль: ${candidate.matchReason}`,
        `Риски: ${candidate.risks.join("; ") || "нет явных"}`
      ].join("\n")
    )
    .join("\n\n");

  const aiAnswer = await askGroqAssistant(`
Вопрос тимлида/админа: ${input.question}

План:
Название: ${plan.title}
Департамент: ${categories[plan.category as Category]}
Дедлайн: ${plan.adjustedDeadline}
Этапы: ${plan.milestones.join("; ")}

Кандидаты, выбранные системой по AI-профилям миниопроса:
${context || "Кандидатов нет"}

Ответь: сможет ли кто-то из стажеров выполнить план, кого выбрать, почему, какие риски и кого подтянуть из другого департамента, если подбор fallback.
`);

  const localAnswer = candidates.length
    ? [
        fallbackUsed
          ? "В выбранном департаменте нет стажеров с достаточно заполненным AI-профилем, поэтому я подобрал кандидатов из других департаментов."
          : "По AI-профилям миниопроса есть кандидаты внутри департамента плана.",
        `Лучший кандидат: ${candidates[0].user.name} (${candidates[0].score}/100).`,
        candidates[0].matchReason,
        candidates[0].risks.length ? `Риски: ${candidates[0].risks.join("; ")}.` : "Критичных рисков по профилю не видно.",
        "Финальное решение лучше подтвердить коротким созвоном и первым контрольным дэйликом."
      ].join("\n")
    : "Не нашел стажеров для подбора. Нужно, чтобы стажеры выбрали департамент и прошли миниопрос.";

  return {
    answer: aiAnswer || localAnswer,
    plan: {
      id: plan.id,
      title: plan.title,
      category: plan.category,
      categoryLabel: categories[plan.category as Category],
      adjustedDeadline: plan.adjustedDeadline,
      milestones: plan.milestones
    },
    candidates,
    fallbackUsed
  };
}

export async function buildDecisionCenter(category?: Category): Promise<DecisionCenter> {
  const dashboard = await buildDashboard(category);
  const aiSummary = await buildAiSummary(category);
  const plan = category
    ? await PlanModel.findOne({ category, ...activePlanFilter }).sort({ createdAt: -1 })
    : await PlanModel.findOne(activePlanFilter).sort({ updatedAt: -1 });
  const planFit = plan
    ? await buildPlanFitAssistant({
        requester: { role: "admin", category: undefined } as UserDocument,
        question: "Кого лучше поставить на текущий план проекта?",
        planId: plan.id
      })
    : { candidates: [] as PlanFitCandidate[] };

  const today = todayIso();
  const missingReports = dashboard.interns
    .filter((intern) => !dashboard.reports.some((report) => report.userId.toString() === intern.id && report.date === today))
    .map((intern) => ({
      id: intern.id,
      name: intern.name,
      email: intern.email,
      role: intern.role,
      category: intern.category,
      categoryLabel: intern.categoryLabel,
      avatarColor: intern.avatarColor,
      firstLoginCompleted: intern.firstLoginCompleted,
      emailVerified: intern.emailVerified,
      lastActiveAt: intern.lastActiveAt
    }));

  const attention = aiSummary.interns
    .filter((intern) => intern.stats.averageScore > 0 && (intern.stats.averageScore < 65 || intern.stats.blockerReports > 0))
    .slice(0, 5)
    .map((intern) => ({
      user: intern.user,
      reason:
        intern.stats.averageScore < 65
          ? `Низкая средняя продуктивность: ${intern.stats.averageScore}%`
          : `Есть блокеры в дэйликах: ${intern.stats.blockerReports}`,
      severity: intern.stats.averageScore < 50 ? ("high" as const) : intern.stats.blockerReports > 1 ? ("medium" as const) : ("low" as const)
    }));

  const blockerReports: DecisionCenter["blockerReports"] = dashboard.reports
    .filter((report) => report.blockers?.trim())
    .slice(0, 5)
    .flatMap((report) => {
      const user = dashboard.interns.find((intern) => intern.id === report.userId.toString());
      if (!user) return [];
      return [{
        user: user
          ,
        date: report.date,
        blockers: report.blockers,
        aiSummary: report.aiReview?.summary
      }];
    });

  const recommended = planFit.candidates.slice(0, 3);
  const summary = [
    plan ? `Активный план: ${plan.title}.` : "Активный план не найден.",
    recommended.length ? `Лучший кандидат: ${recommended[0].user.name} (${recommended[0].score}/100).` : "Нет кандидатов с AI-профилем для рекомендации.",
    missingReports.length ? `Не сдали дэйлик сегодня: ${missingReports.length}.` : "Все стажеры сдали дэйлики или список пуст.",
    attention.length ? `В зоне внимания: ${attention.length}.` : "Критичных просадок по стажерам не видно."
  ].join(" ");

  return {
    scope: category ? "department" : "all",
    plan: plan
      ? {
          id: plan.id,
          title: plan.title,
          category: plan.category as Category,
          categoryLabel: categories[plan.category as Category],
          adjustedDeadline: plan.adjustedDeadline,
          milestones: plan.milestones
        }
      : undefined,
    recommended,
    attention,
    missingReports,
    blockerReports,
    summary
  };
}
