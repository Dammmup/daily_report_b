import type { Types } from "mongoose";
import { reviewReport } from "./ai.js";
import { addDays, categories, todayIso } from "./constants.js";
import { AttendanceModel, PlanModel, ReportModel, SurveyModel, UserModel, type UserDocument } from "./models.js";
import type { Category } from "./types.js";

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
    lastActiveAt: user.lastActiveAt.toISOString()
  };
}

export async function createDailyReport(input: {
  userId: Types.ObjectId | string;
  yesterday: string;
  todayPlan: string;
  blockers: string;
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
  const report = await ReportModel.create({
    userId: input.userId,
    date: todayIso(),
    yesterday: input.yesterday,
    todayPlan: input.todayPlan,
    blockers: input.blockers,
    source: input.source,
    status: now.getHours() >= 10 ? "late" : "submitted",
    aiReview
  });

  const plan = await PlanModel.findOne({ category: user.category });
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
    const plan = plans.find((item) => item.category === user.category);

    return {
      ...publicUser(user),
      attendanceCount: attendance.filter((item) => item.userId.toString() === user.id).length,
      reportsCount: userReports.length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
      activeToday: attendance.some((item) => item.userId.toString() === user.id && item.date === todayIso()),
      survey,
      plan
    };
  });

  return {
    stats: {
      internsTotal: interns.length,
      checkedInToday: attendance.filter((item) => internIds.has(item.userId.toString()) && item.date === todayIso()).length,
      reportsTotal: scopedReports.length,
      aiReviewedReports: scopedReports.filter((report) => report.aiReview).length,
      averageScore,
      byCategory
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

  const plan = user.category ? await PlanModel.findOne({ category: user.category }) : null;
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
