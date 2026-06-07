import type { Types } from "mongoose";
import { askGroqAssistant, reviewReport } from "./ai.js";
import { addDays, categories, todayIso } from "./constants.js";
import { businessHour, businessWeekStartIso } from "./date.js";
import { AttendanceModel, PlanModel, ReportModel, StepArtifactModel, SurveyModel, UserModel, type UserDocument } from "./models.js";
import type { AssignmentDraft, Category, DecisionCenter, PlanFitCandidate } from "./types.js";

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
    telegramUserId: user.telegramUserId || undefined,
    telegramUsername: user.telegramUsername || undefined,
    registrationSource: user.registrationSource || undefined,
    registrationReferrer: user.registrationReferrer || undefined,
    registrationUtmSource: user.registrationUtmSource || undefined,
    registrationUtmMedium: user.registrationUtmMedium || undefined,
    registrationUtmCampaign: user.registrationUtmCampaign || undefined,
    registrationSocialSource: user.registrationSocialSource || undefined,
    lastActiveAt: user.lastActiveAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
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
  const plans = await PlanModel.find({ category: user.category, ...activePlanFilter }).sort({ createdAt: -1 });
  const linkedStepIds =
    user.role === "intern" && plans.length
      ? (input.linkedStepIds || []).filter((stepId) =>
          plans.some((plan) => {
            const step = plan.steps.id(stepId);
            return Boolean(step && step.assignedTo?.toString() === user.id);
          })
        )
      : [];

  const report = await ReportModel.create({
    userId: input.userId,
    date: todayIso(),
    yesterday: input.yesterday,
    todayPlan: input.todayPlan,
    blockers: input.blockers,
    linkedStepIds,
    source: input.source,
    status: businessHour(now) >= 10 ? "late" : "submitted",
    aiReview
  });

  if (user.role === "intern" && plans.length && linkedStepIds.length && aiReview.deadlineImpactDays > 0) {
    const affectedPlanIds = new Set(
      linkedStepIds.flatMap((stepId) => plans.filter((plan) => plan.steps.id(stepId)).map((plan) => plan.id))
    );
    const plansToExtend = plans.filter((plan) => affectedPlanIds.has(plan.id));
    await Promise.all(
      plansToExtend.map(async (plan) => {
        plan.adjustedDeadline = addDays(plan.adjustedDeadline, aiReview.deadlineImpactDays);
        plan.aiRationale = `AI продлил срок на ${aiReview.deadlineImpactDays} дн. из-за блокера в дэйлике стажера.`;
        await plan.save();
      })
    );
  }

  return report;
}

export async function buildDashboard(category?: Category) {
  const interns = await UserModel.find({ role: "intern", ...(category ? { category } : {}) }).sort({ name: 1 });
  const internIds = new Set(interns.map((user) => user.id));
  const internObjectIds = interns.map((user) => user._id);
  const [attendance, scopedReports, surveys, plans] = await Promise.all([
    internObjectIds.length ? AttendanceModel.find({ userId: { $in: internObjectIds } }) : [],
    internObjectIds.length ? ReportModel.find({ userId: { $in: internObjectIds } }).sort({ createdAt: -1 }) : [],
    internObjectIds.length ? SurveyModel.find({ userId: { $in: internObjectIds } }) : [],
    PlanModel.find({ ...(category ? { category } : {}), ...activePlanFilter }).sort({ createdAt: -1 })
  ]);

  const reportScores = scopedReports
    .map((report) => report.aiReview?.productivityScore)
    .filter((score): score is number => typeof score === "number");
  const averageScore = reportScores.length ? Math.round(reportScores.reduce((sum, score) => sum + score, 0) / reportScores.length) : 0;
  const reportsByUser = new Map<string, typeof scopedReports>();
  const attendanceByUser = new Map<string, typeof attendance>();
  const surveyByUser = new Map(surveys.map((survey) => [survey.userId.toString(), survey]));
  const plansByCategory = new Map<string, typeof plans>();

  for (const report of scopedReports) {
    const key = report.userId.toString();
    reportsByUser.set(key, [...(reportsByUser.get(key) || []), report]);
  }
  for (const item of attendance) {
    const key = item.userId.toString();
    attendanceByUser.set(key, [...(attendanceByUser.get(key) || []), item]);
  }
  for (const plan of plans) {
    plansByCategory.set(plan.category, [...(plansByCategory.get(plan.category) || []), plan]);
  }

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
    const userReports = reportsByUser.get(user.id) || [];
    const scores = userReports.map((report) => report.aiReview?.productivityScore || 0);
    const survey = surveyByUser.get(user.id);
    const userPlans = user.category ? plansByCategory.get(user.category) || [] : [];
    const plan = userPlans[0];
    const userAttendance = attendanceByUser.get(user.id) || [];
    const officeAttendanceCount = userAttendance.filter((item) => item.locationStatus === "verified").length;
    const weekStart = businessWeekStartIso();
    const currentWeekOfficeDays = new Set(
      userAttendance
        .filter((item) => item.locationStatus === "verified" && item.date >= weekStart)
        .map((item) => item.date)
    ).size;

    return {
      ...publicUser(user),
      attendanceCount: userAttendance.length,
      officeAttendanceCount,
      currentWeekOfficeDays,
      reportsCount: userReports.length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
      activeToday: userAttendance.some((item) => item.date === todayIso()),
      survey,
      plan,
      assignedOpenSteps: userPlans.reduce(
        (sum, item) =>
          sum + item.steps.filter((step) => step.assignedTo?.toString() === user.id && step.status !== "done" && step.status !== "canceled").length,
        0
      )
    };
  });

  return {
    stats: {
      internsTotal: interns.length,
      checkedInToday: attendance.filter((item) => internIds.has(item.userId.toString()) && item.date === todayIso()).length,
      reportsTotal: scopedReports.length,
      aiReviewedReports: scopedReports.filter((report) => report.aiReview).length,
      averageScore,
      byCategory,
      plans: plans.map((plan) => ({
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
          .filter((item) => item.locationStatus === "verified" && item.date >= businessWeekStartIso())
          .map((item) => item.date)
      ).size,
      blockerReports: blockerReports.length,
      lastReportAt: reports[0]?.createdAt?.toISOString()
    }
  };
}

export async function buildAiSummary(category?: Category, preloadedDashboard?: Awaited<ReturnType<typeof buildDashboard>>) {
  const dashboard = preloadedDashboard || await buildDashboard(category);

  const interns = dashboard.interns
    .filter((intern) => !category || intern.category === category)
    .map((intern) => {
      const latestReport = dashboard.reports.find((report) => report.userId.toString() === intern.id);
      return {
        user: intern,
        stats: {
          reportsCount: intern.reportsCount,
          aiReviewedReports: dashboard.reports.filter((report) => report.userId.toString() === intern.id && report.aiReview).length,
          averageScore: intern.averageScore,
          attendanceCount: intern.attendanceCount,
          officeAttendanceCount: intern.officeAttendanceCount,
          currentWeekOfficeDays: intern.currentWeekOfficeDays,
          blockerReports: dashboard.reports.filter((report) => report.userId.toString() === intern.id && report.blockers.trim().length > 0).length,
          lastReportAt: latestReport?.createdAt?.toISOString()
        },
        surveyAnalysis: intern.survey?.analysis,
        latestReportAi: latestReport?.aiReview,
        latestReportDate: latestReport?.date,
        plan: intern.plan
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
  const aiSummary = await buildAiSummary(category, dashboard);
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

function textOf(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (depth > 4) return "";
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1, seen)).join(" ");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (seen.has(value)) return "";
    seen.add(value);

    const plain = Object.getPrototypeOf(value) === Object.prototype ? (value as Record<string, unknown>) : {};
    return Object.entries(plain)
      .filter(([key]) => !key.startsWith("_") && !key.startsWith("$") && !["schema", "db", "collection", "parent", "ownerDocument"].includes(key))
      .map(([, item]) => textOf(item, depth + 1, seen))
      .join(" ");
  }
  return String(value);
}

function surveySearchText(survey?: {
  answers?: {
    traits?: string[];
    skills?: string;
    experience?: string;
    learningStyle?: string;
    goal?: string;
  } | null;
  analysis?: {
    strengths?: string[];
    weaknesses?: string[];
    skillsSummary?: string;
    experienceSummary?: string;
    goalAlignment?: string;
    suggestedTrack?: string;
    mentorFocus?: string[];
    recommendation?: string;
    riskLevel?: string;
  } | null;
}) {
  if (!survey) return "";
  const answers = survey.answers || {};
  const analysis = survey.analysis || {};
  return [
    ...(answers.traits || []),
    answers.skills,
    answers.experience,
    answers.learningStyle,
    answers.goal,
    ...(analysis.strengths || []),
    ...(analysis.weaknesses || []),
    analysis.skillsSummary,
    analysis.experienceSummary,
    analysis.goalAlignment,
    analysis.suggestedTrack,
    ...(analysis.mentorFocus || []),
    analysis.recommendation,
    analysis.riskLevel
  ]
    .filter(Boolean)
    .join(" ");
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

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function confidenceByScore(score: number): "low" | "medium" | "high" {
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  return "low";
}

function openAssignedStepsForUser(plans: Awaited<ReturnType<typeof PlanModel.find>>, userId: string) {
  return plans.reduce(
    (sum, plan) =>
      sum + (plan.steps || []).filter((step) => step.assignedTo?.toString() === userId && step.status !== "done" && step.status !== "canceled").length,
    0
  );
}

export async function buildAssignmentDraft(input: {
  requester: UserDocument;
  planId: string;
}): Promise<AssignmentDraft> {
  const plan =
    input.requester.role === "admin"
      ? await PlanModel.findById(input.planId)
      : input.requester.category
        ? await PlanModel.findOne({ _id: input.planId, category: input.requester.category })
        : null;

  if (!plan) {
    return {
      plan: null,
      summary: "План не найден или недоступен для распределения.",
      items: [],
      skippedSteps: []
    };
  }

  const targetSteps = (plan.steps || []).filter((step) => !step.assignedTo && step.status !== "done" && step.status !== "canceled");
  const skippedSteps = (plan.steps || [])
    .filter((step) => step.assignedTo || step.status === "done" || step.status === "canceled")
    .map((step) => ({
      stepId: step._id.toString(),
      title: step.title,
      reason: step.assignedTo ? "Шаг уже назначен" : step.status === "done" ? "Шаг уже завершен" : "Шаг отменен"
    }));

  if (!targetSteps.length) {
    return {
      plan: {
        id: plan.id,
        title: plan.title,
        category: plan.category as Category,
        categoryLabel: categories[plan.category as Category],
        adjustedDeadline: plan.adjustedDeadline
      },
      summary: "Свободных шагов для AI-распределения нет. Все шаги уже назначены, завершены или отменены.",
      items: [],
      skippedSteps
    };
  }

  const [interns, surveys, reports, attendance, activePlans] = await Promise.all([
    UserModel.find({ role: "intern" }).sort({ name: 1 }),
    SurveyModel.find().lean(),
    ReportModel.find().sort({ createdAt: -1 }),
    AttendanceModel.find().sort({ createdAt: -1 }),
    PlanModel.find(activePlanFilter)
  ]);

  const surveyByUser = new Map(surveys.map((survey) => [survey.userId.toString(), survey]));
  const reportsByUser = new Map<string, typeof reports>();
  const attendanceByUser = new Map<string, typeof attendance>();
  for (const report of reports) {
    const key = report.userId.toString();
    reportsByUser.set(key, [...(reportsByUser.get(key) || []), report]);
  }
  for (const item of attendance) {
    const key = item.userId.toString();
    attendanceByUser.set(key, [...(attendanceByUser.get(key) || []), item]);
  }

  const plannedLoad = new Map<string, number>();
  const planContext = `${plan.title} ${plan.milestones.join(" ")} ${plan.aiRationale}`;

  const candidateBase = interns.map((user) => {
    const survey = surveyByUser.get(user.id);
    const userReports = reportsByUser.get(user.id) || [];
    const userAttendance = attendanceByUser.get(user.id) || [];
    const scores = userReports.map((report) => report.aiReview?.productivityScore || 0);
    const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
    const blockerReports = userReports.filter((report) => report.blockers.trim()).length;
    const officeDays = new Set(userAttendance.filter((item) => item.locationStatus === "verified").map((item) => item.date)).size;
    const assignedOpen = openAssignedStepsForUser(activePlans, user.id);
    const sameDepartment = user.category === plan.category;

    return {
      user,
      survey,
      surveyText: surveySearchText(survey),
      averageScore,
      reportsCount: userReports.length,
      blockerReports,
      officeDays,
      assignedOpen,
      sameDepartment
    };
  });

  const items = targetSteps.flatMap((step) => {
    const stepText = [planContext, step.title, step.description, step.technicalSpec, step.technicalInstruction].filter(Boolean).join(" ");
    const ranked = candidateBase
      .map((candidate) => {
        const workload = candidate.assignedOpen + (plannedLoad.get(candidate.user.id) || 0);
        const baseScore = scoreCandidate(stepText, candidate.surveyText, candidate.averageScore, candidate.sameDepartment);
        const surveyBonus = candidate.survey ? 8 : -8;
        const attendanceBonus = candidate.officeDays >= 2 ? 4 : 0;
        const reportsBonus = candidate.reportsCount ? 4 : -6;
        const blockerPenalty = Math.min(14, candidate.blockerReports * 4);
        const workloadPenalty = Math.min(24, workload * 8);
        const score = clampScore(baseScore + surveyBonus + attendanceBonus + reportsBonus - blockerPenalty - workloadPenalty);

        const risks = [
          candidate.sameDepartment ? "" : "Стажер из другого департамента: перед назначением нужен перевод или отдельное согласование.",
          candidate.survey ? "" : "Нет заполненного AI-профиля из миниопроса.",
          candidate.reportsCount ? "" : "Нет истории дэйликов, темп работы подтвержден слабо.",
          candidate.blockerReports > 1 ? `Есть блокеры в дэйликах: ${candidate.blockerReports}` : "",
          workload > 1 ? `Уже есть открытые задачи: ${workload}` : "",
          candidate.officeDays ? "" : "Нет подтвержденных офисных отметок."
        ].filter(Boolean);

        const strengths = candidate.survey?.analysis?.strengths?.slice(0, 2).join(", ");
        const skills = candidate.survey?.analysis?.skillsSummary;
        const reason = [
          strengths ? `Сильные стороны: ${strengths}.` : "Подбор сделан по продуктивности и доступным данным.",
          skills ? `Навыки: ${skills}` : "",
          `Средняя продуктивность: ${candidate.averageScore}%.`,
          `Текущая нагрузка: ${workload} открытых задач.`
        ]
          .filter(Boolean)
          .join(" ");

        return {
          user: candidate.user,
          survey: candidate.survey,
          score,
          reason,
          risks,
          source: candidate.sameDepartment ? ("same_department" as const) : ("other_department" as const),
          averageScore: candidate.averageScore,
          reportsCount: candidate.reportsCount
        };
      })
      .sort((left, right) => {
        if (left.source !== right.source) return left.source === "same_department" ? -1 : 1;
        return right.score - left.score;
      });

    const primary = ranked.find((candidate) => candidate.source === "same_department") || ranked[0];
    if (!primary) return [];
    plannedLoad.set(primary.user.id, (plannedLoad.get(primary.user.id) || 0) + 1);

    const alternatives = ranked.slice(0, 4).map((candidate) => ({
      user: publicUser(candidate.user),
      score: candidate.score,
      matchReason: candidate.reason,
      risks: candidate.risks,
      source: candidate.source,
      surveyAnalysis: candidate.survey?.analysis,
      averageScore: candidate.averageScore,
      reportsCount: candidate.reportsCount
    }));

    return [{
      stepId: step._id.toString(),
      stepTitle: step.title,
      stepDescription: step.description,
      deadline: step.deadline,
      recommendedUser: publicUser(primary.user),
      score: primary.score,
      confidence: confidenceByScore(primary.score),
      source: primary.source,
      assignable: primary.user.category === plan.category,
      reason: primary.reason,
      risks: primary.risks,
      alternatives
    }];
  });

  const assignable = items.filter((item) => item.assignable).length;
  const summary = [
    `AI-PM подготовил распределение: ${items.length} шагов.`,
    assignable ? `Можно применить сразу: ${assignable}.` : "Автоматически применимых назначений нет.",
    items.some((item) => !item.assignable) ? "Есть кандидаты из других департаментов: их нужно сначала перевести или согласовать вручную." : "",
    skippedSteps.length ? `Пропущено уже занятых/закрытых шагов: ${skippedSteps.length}.` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return {
    plan: {
      id: plan.id,
      title: plan.title,
      category: plan.category as Category,
      categoryLabel: categories[plan.category as Category],
      adjustedDeadline: plan.adjustedDeadline
    },
    summary,
    items,
    skippedSteps
  };
}

export async function buildPlanFitAssistant(input: {
  requester: UserDocument;
  question: string;
  planId?: string;
  stepId?: string;
  skipAi?: boolean;
}) {
  const plan =
    input.planId && input.requester.role === "admin"
      ? await PlanModel.findById(input.planId)
      : input.planId && input.requester.category
        ? await PlanModel.findOne({ _id: input.planId, category: input.requester.category, ...activePlanFilter } as any)
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

  const selectedStep = input.stepId ? plan.steps.id(input.stepId) : null;
  const [interns, surveys] = await Promise.all([
    UserModel.find({ role: "intern" }).sort({ name: 1 }),
    SurveyModel.find().lean()
  ]);
  const reports = interns.length ? await ReportModel.find({ userId: { $in: interns.map((user) => user._id) } }).sort({ createdAt: -1 }) : [];
  const stepArtifacts = await StepArtifactModel.find({
    planId: plan._id,
    ...(selectedStep ? { stepId: selectedStep._id } : {})
  }).sort({ createdAt: -1 });
  const artifactUsers = stepArtifacts.length ? await UserModel.find({ _id: { $in: stepArtifacts.map((artifact) => artifact.userId) } }) : [];
  const artifactContext = stepArtifacts
    .slice(0, 20)
    .map((artifact) => {
      const step = plan.steps.id(artifact.stepId.toString());
      const author = artifactUsers.find((user) => user.id === artifact.userId.toString());
      return [
        `Шаг: ${step?.title || artifact.stepId.toString()}`,
        `Материал: ${artifact.title}`,
        `Ссылка: ${artifact.url}`,
        `Автор: ${author?.name || artifact.userId.toString()}`,
        `Добавлено: ${artifact.createdAt.toISOString()}`
      ].join(" | ");
    })
    .join("\n");

  const planText = selectedStep
    ? `${selectedStep.title} ${selectedStep.description || ""} ${selectedStep.technicalSpec || ""} ${selectedStep.technicalInstruction || ""} ${selectedStep.deadline || ""} ${artifactContext}`
    : `${plan.title} ${plan.milestones.join(" ")} ${plan.aiRationale} ${artifactContext}`;
  const rows = interns.map((user) => {
    const survey = surveys.find((item) => item.userId.toString() === user.id);
    const userReports = reports.filter((report) => report.userId.toString() === user.id);
    const scores = userReports.map((report) => report.aiReview?.productivityScore || 0);
    const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
    const sameDepartment = user.category === plan.category;
    const surveyText = surveySearchText(survey);
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

  const aiAnswer = input.skipAi
    ? ""
    : await askGroqAssistant(`
Вопрос тимлида/админа: ${input.question}

План:
Название: ${plan.title}
Департамент: ${categories[plan.category as Category]}
Дедлайн: ${plan.adjustedDeadline}
Этапы: ${plan.milestones.join("; ")}
${selectedStep ? `\nВыбранная задача:\n${selectedStep.title}\n${selectedStep.description || ""}\nТЗ: ${selectedStep.technicalSpec || "не указано"}\nИнструкция: ${selectedStep.technicalInstruction || "не указано"}\nДедлайн: ${selectedStep.deadline}` : ""}

Материалы и ссылки, прикрепленные к выполнению шагов:
${artifactContext || "Пока не прикреплены"}

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
    target: selectedStep
      ? {
          type: "step" as const,
          stepId: selectedStep._id.toString(),
          stepTitle: selectedStep.title
        }
      : { type: "plan" as const },
    candidates,
    fallbackUsed
  };
}

export async function buildDecisionCenter(category?: Category): Promise<DecisionCenter> {
  const dashboard = await buildDashboard(category);
  const aiSummary = await buildAiSummary(category, dashboard);
  const plan = category
    ? await PlanModel.findOne({ category, ...activePlanFilter }).sort({ createdAt: -1 })
    : await PlanModel.findOne(activePlanFilter).sort({ updatedAt: -1 });
  const planFit = plan
    ? await buildPlanFitAssistant({
        requester: { role: "admin", category: undefined } as UserDocument,
        question: "Кого лучше поставить на текущий план проекта?",
        planId: plan.id,
        skipAi: true
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
