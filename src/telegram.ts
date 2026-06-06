import { Markup, Telegraf, type Context } from "telegraf";
import { hashPassword } from "./auth.js";
import { askGroqAssistant, askGroqTelegramAssistant, transcribeAudio } from "./ai.js";
import { categories, randomAvatarColor } from "./constants.js";
import { PlanChangeModel, PlanModel, ReportModel, TelegramActivityModel, TelegramDraftModel, TelegramGroupModel, UserModel } from "./models.js";
import { createDailyReport, formatLeadSummary } from "./services.js";
import type { Category } from "./types.js";

type DigestContent = "productivity" | "reports" | "full";
type TelegramFunMedia = {
  type: "animation" | "sticker";
  fileId: string;
  fileUniqueId?: string;
};

let botInstance: Telegraf | undefined;
let pollingStarted = false;
let digestTimer: NodeJS.Timeout | undefined;
let funTimer: NodeJS.Timeout | undefined;
const temporaryGroupMessageTtlMs = Number(process.env.TELEGRAM_TEMP_MESSAGE_TTL_MS || 5000);
const activePlanFilter = { status: { $in: ["draft", "approved"] as const } } as any;
const almatyUtcOffsetMs = 5 * 60 * 60 * 1000;
const funReplyLookbackMs = 72 * 60 * 60 * 1000;
const telegramAiWindowMs = 10 * 60 * 1000;
const telegramAiCooldownMs = 20 * 60 * 1000;

const tileKeyboard = Markup.keyboard([
  ["План", "Дэйлик"],
  ["Сводка", "Автосводка"],
  ["Привязка", "Меню"]
]).resize();

const inlineMenu = Markup.inlineKeyboard([
  [Markup.button.callback("План департамента", "plan:view"), Markup.button.callback("Дэйлик", "report:help")],
  [Markup.button.callback("Сводка", "summary:view"), Markup.button.callback("Автосводка", "digest:view")],
  [Markup.button.callback("Привязка Telegram", "link:help")]
]);

const appUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://daily-report-f.vercel.app";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isSameIsoDay(date?: Date | null) {
  return date?.toISOString().slice(0, 10) === todayIso();
}

function isWeekdayUtc() {
  const weekday = new Date().getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function randomItem<T>(items: readonly T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

function nextRandomFunReplyAt(now = new Date()) {
  const localNow = new Date(now.getTime() + almatyUtcOffsetMs);
  const localMidnightMs = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const minimumLeadMs = 30 * 60 * 1000;

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const localDayMs = localMidnightMs + dayOffset * 24 * 60 * 60 * 1000;
    const weekday = new Date(localDayMs).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    const randomMinute = 10 * 60 + Math.floor(Math.random() * 8 * 60);
    const candidate = new Date(localDayMs + randomMinute * 60 * 1000 - almatyUtcOffsetMs);
    if (candidate.getTime() > now.getTime() + minimumLeadMs) return candidate;
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

const departmentKeywords: Record<Category, string[]> = {
  "data-analytics": ["data", "данн", "аналит", "дашборд", "метрик", "bi"],
  "system-analytics": ["system", "систем", "требован", "bpmn", "uml", "аналит"],
  "machine-learning": ["ml", "machine", "машин", "модель", "нейро", "ai"],
  "marketing": ["marketing", "маркет", "контент", "smm", "instagram"],
  "sales": ["sales", "продаж", "лид", "ворон"],
  "erp-development": ["erp", "разработ", "dev", "frontend", "backend"],
  "data-security": ["security", "безопас", "защит", "данных"]
};

const categoryAliases: Record<string, Category> = {
  data: "data-analytics",
  analytics: "data-analytics",
  analyst: "data-analytics",
  system: "system-analytics",
  systems: "system-analytics",
  sa: "system-analytics",
  ml: "machine-learning",
  ai: "machine-learning",
  marketing: "marketing",
  smm: "marketing",
  sales: "sales",
  erp: "erp-development",
  dev: "erp-development",
  security: "data-security"
};

function parseReport(text: string) {
  const lines = text
    .replace(/^\/report(@\w+)?/i, "")
    .trim()
    .split("|")
    .map((part) => part.trim());

  if (lines.length < 2) return null;
  return {
    yesterday: lines[0],
    todayPlan: lines[1],
    blockers: lines[2] || ""
  };
}

function parseDigest(text: string) {
  const [, action, time, content] = text.trim().split(/\s+/);
  return {
    action,
    time,
    content: (content || "full") as DigestContent
  };
}

function isGroupChat(ctx: Context) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function activeGroupQuery(query: Record<string, unknown> = {}) {
  return { ...query, active: { $ne: false } };
}

function isTelegramInactiveChatError(error: unknown) {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return /bot was kicked|bot was blocked|chat not found|forbidden|not enough rights|deactivated/i.test(message);
}

async function deactivateTelegramGroup(chatId: string, error?: unknown) {
  await TelegramGroupModel.updateOne(
    { chatId },
    {
      $set: {
        active: false,
        lastActivityAt: new Date()
      }
    }
  );
  if (error) console.warn(`Telegram group ${chatId} marked inactive`, error);
}

async function markTelegramGroupActive(chatId: string, title?: string, category?: Category) {
  await TelegramGroupModel.findOneAndUpdate(
    { chatId },
    {
      chatId,
      ...(title ? { title } : {}),
      ...(category ? { category } : {}),
      active: true,
      lastActivityAt: new Date()
    },
    { upsert: true }
  );
}

async function deactivateGroupAfterSendError(chatId: string, error: unknown) {
  if (!isTelegramInactiveChatError(error)) return;
  await deactivateTelegramGroup(chatId, error);
}

async function findDepartmentTelegramGroups(category: Category | string, options: { motivationOnly?: boolean } = {}) {
  const groups = await TelegramGroupModel.find(
    activeGroupQuery({
      category,
      chatId: { $type: "string", $ne: "" }
    })
  ).sort({ isPrimary: -1, lastActivityAt: -1 });
  const primary = groups.find((group) => group.isPrimary);
  const targets = primary ? [primary] : groups;
  return options.motivationOnly ? targets.filter((group) => group.motivationEnabled) : targets;
}

async function findAllDepartmentTelegramGroups(options: { motivationOnly?: boolean } = {}) {
  const groups = await TelegramGroupModel.find(
    activeGroupQuery({
      category: { $exists: true },
      chatId: { $type: "string", $ne: "" }
    })
  ).sort({ category: 1, isPrimary: -1, lastActivityAt: -1 });
  const byCategory = new Map<string, typeof groups>();
  for (const group of groups) {
    if (!group.category) continue;
    const key = String(group.category);
    byCategory.set(key, [...(byCategory.get(key) || []), group]);
  }

  return Array.from(byCategory.values()).flatMap((items) => {
    const primary = items.find((group) => group.isPrimary);
    const targets = primary ? [primary] : items;
    return options.motivationOnly ? targets.filter((group) => group.motivationEnabled) : targets;
  });
}

async function shouldUseGroupForDepartmentAnalytics(chatId: string, category: Category | string) {
  const targets = await findDepartmentTelegramGroups(category);
  return !targets.length || targets.some((group) => group.chatId === chatId);
}

function isCallbackContext(ctx: Context) {
  return Boolean("callbackQuery" in ctx.update && ctx.update.callbackQuery);
}

async function replyAccessDenied(ctx: Context, message: string) {
  if (isCallbackContext(ctx)) {
    await ctx.answerCbQuery(message, { show_alert: true });
    return;
  }
  if (isGroupChat(ctx)) {
    await replyTemporary(ctx, message, undefined, 700);
    return;
  }
  await ctx.reply(message);
}

async function requireGroupAdmin(ctx: Context) {
  if (!isGroupChat(ctx)) {
    await replyAccessDenied(ctx, "Эта настройка доступна только в группе департамента.");
    return false;
  }

  if (!ctx.from) {
    await replyAccessDenied(ctx, "Не удалось определить пользователя.");
    return false;
  }

  const chat = ctx.chat;
  if (!chat) {
    await replyAccessDenied(ctx, "Не удалось определить группу.");
    return false;
  }

  const message = ctx.message;
  const senderChat = message && "sender_chat" in message ? message.sender_chat : undefined;
  if (senderChat?.id === chat.id) return true;

  const member = await ctx.telegram.getChatMember(chat.id, ctx.from.id);
  const allowed = member.status === "administrator" || member.status === "creator";
  if (!allowed) {
    await replyAccessDenied(ctx, "Эти кнопки доступны только администраторам группы.");
  }

  return allowed;
}

function isPrivateChat(ctx: Context) {
  return ctx.chat?.type === "private";
}

async function requirePrivateChat(ctx: Context, message = "Эта команда доступна только в личном чате с ботом.") {
  if (isPrivateChat(ctx)) return true;
  if (isCallbackContext(ctx)) {
    await ctx.answerCbQuery(message, { show_alert: true });
  } else if (isGroupChat(ctx)) {
    await replyTemporary(ctx, message, undefined, 800);
  } else {
    await ctx.reply(message);
  }
  return false;
}

function scheduleMessageDelete(ctx: Context, messageId: number, delayMs = temporaryGroupMessageTtlMs) {
  if (!isGroupChat(ctx)) return;

  setTimeout(() => {
    void ctx.telegram.deleteMessage(ctx.chat!.id, messageId).catch(() => undefined);
  }, Math.max(0, delayMs));
}

async function replyTemporary(ctx: Context, text: string, extra?: Parameters<Context["reply"]>[1], delayMs = temporaryGroupMessageTtlMs) {
  const sent = await ctx.reply(text, extra);
  scheduleMessageDelete(ctx, sent.message_id, delayMs);
  return sent;
}

function deleteCallbackSourceLater(ctx: Context, delayMs = temporaryGroupMessageTtlMs) {
  if (!isGroupChat(ctx)) return;
  const callbackQuery = "callbackQuery" in ctx.update ? (ctx.update.callbackQuery as { message?: { message_id?: number } }) : undefined;
  const messageId = callbackQuery?.message?.message_id;
  if (messageId) {
    scheduleMessageDelete(ctx, messageId, delayMs);
  }
}

function deleteIncomingMessageLater(ctx: Context, delayMs = temporaryGroupMessageTtlMs) {
  if (!isGroupChat(ctx)) return;
  const messageId = ctx.message?.message_id;
  if (messageId) scheduleMessageDelete(ctx, messageId, delayMs);
}

function digestContentLabel(content?: string) {
  if (content === "productivity") return "продуктивность дня";
  if (content === "reports") return "посещаемость и отчеты";
  return "полная сводка";
}

type PlanStepStatus = "todo" | "in_progress" | "done" | "canceled";
type TelegramPlanDocument = NonNullable<Awaited<ReturnType<typeof PlanModel.findOne>>>;

function stepStatusLabel(status: string) {
  if (status === "done") return "готово";
  if (status === "in_progress") return "в работе";
  if (status === "canceled") return "отменено";
  return "ожидает";
}

function formatShortDate(value: string) {
  const [year, month, day] = value.split("-");
  const monthLabels = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const monthIndex = Number(month) - 1;
  if (!year || !day || monthIndex < 0 || monthIndex >= monthLabels.length) return value;
  return `${Number(day)} ${monthLabels[monthIndex]} ${year}`;
}

function formatPlanForTelegram(plan: Awaited<ReturnType<typeof PlanModel.findOne>>, chatUserId?: string) {
  if (!plan) return "План для вашего департамента еще не создан тимлидом.";
  const steps = (plan.steps || [])
    .slice(0, 10)
    .map((step, index) => {
      const assigned = step.assignedTo?.toString() === chatUserId ? " | назначено вам" : step.assignedTo ? " | назначено" : "";
      const status = stepStatusLabel(step.status);
      const details = [step.description, step.technicalSpec ? `ТЗ: ${step.technicalSpec}` : "", step.technicalInstruction ? `Инструкция: ${step.technicalInstruction}` : ""]
        .filter(Boolean)
        .join(" ");
      return `${index + 1}. ${step.title} - до ${step.deadline} | ${status}${assigned}${details ? `\n   ${details.slice(0, 220)}` : ""}`;
    })
    .join("\n");

  return [
    `План: ${plan.title}`,
    `Дедлайн: ${plan.adjustedDeadline}`,
    `Последнее изменение: ${plan.updatedAt.toISOString().slice(0, 16).replace("T", " ")}`,
    plan.aiRationale,
    steps ? `Шаги:\n${steps}` : `Этапы:\n${plan.milestones.join("\n")}`
  ].join("\n");
}

async function findActivePlans(category: Category | string, limit = 5) {
  return PlanModel.find({ category, ...activePlanFilter }).sort({ createdAt: -1 }).limit(limit);
}

function formatPlansForTelegram(plans: TelegramPlanDocument[], chatUserId?: string) {
  if (!plans.length) return "Планы для вашего департамента еще не созданы.";
  if (plans.length === 1) return formatPlanForTelegram(plans[0], chatUserId);

  return [
    `Активные планы департамента: ${plans.length}`,
    ...plans.map((plan, planIndex) => {
      const steps = (plan.steps || [])
        .slice(0, 6)
        .map((step, index) => {
          const assigned = step.assignedTo?.toString() === chatUserId ? " | назначено вам" : step.assignedTo ? " | назначено" : "";
          return `   ${index + 1}. ${step.title} - до ${step.deadline} | ${stepStatusLabel(step.status)}${assigned}`;
        })
        .join("\n");

      return [
        `${planIndex + 1}. ${plan.title}`,
        `   Версия: #${plan.version || planIndex + 1} | дедлайн: ${plan.adjustedDeadline}`,
        `   Изменен: ${plan.updatedAt.toISOString().slice(0, 16).replace("T", " ")}`,
        steps ? `   Шаги:\n${steps}` : `   Этапы: ${plan.milestones.slice(0, 4).join("; ")}`
      ].join("\n");
    })
  ].join("\n\n");
}

function isServerlessRuntime() {
  return process.env.VERCEL === "1" || process.env.TELEGRAM_BOT_MODE === "webhook";
}

function detectCategoryFromGroupTitle(title: string): Category | undefined {
  const normalized = title.toLowerCase();
  const match = Object.entries(departmentKeywords).find(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)));
  return match?.[0] as Category | undefined;
}

function parseCategoryAlias(value?: string) {
  if (!value) return undefined;
  return categoryAliases[value.trim().toLowerCase()];
}

function groupDepartmentKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("ERP", "group:department:erp"), Markup.button.callback("Data", "group:department:data")],
    [Markup.button.callback("System Analytics", "group:department:system"), Markup.button.callback("ML", "group:department:ml")],
    [Markup.button.callback("Marketing", "group:department:marketing"), Markup.button.callback("Sales", "group:department:sales")],
    [Markup.button.callback("Security", "group:department:security")]
  ]);
}

function groupActionsKeyboard(enabled?: boolean, funEnabled?: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Статус группы", "group:status"), Markup.button.callback("Сменить департамент", "group:department:choose")],
    [Markup.button.callback("План группы", "plan:view"), Markup.button.callback("Дайджест дня", "group:digest:now")],
    [Markup.button.callback("Отправить мотивацию", "group:motivation:now")],
    [
      enabled
        ? Markup.button.callback("Отключить мотивацию", "group:motivation:off")
        : Markup.button.callback("Включить мотивацию", "group:motivation:on")
    ],
    [
      funEnabled
        ? Markup.button.callback("Отключить GIF/стикеры", "group:fun:off")
        : Markup.button.callback("Включить GIF/стикеры", "group:fun:on")
    ]
  ]);
}

function groupMenuKeyboard(enabled?: boolean, funEnabled?: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("План группы", "plan:view"), Markup.button.callback("Сводка группы", "summary:view")],
    [Markup.button.callback("Статус группы", "group:status"), Markup.button.callback("Сменить департамент", "group:department:choose")],
    [Markup.button.callback("Дайджест дня", "group:digest:now"), Markup.button.callback("Отправить мотивацию", "group:motivation:now")],
    [
      enabled
        ? Markup.button.callback("Отключить мотивацию", "group:motivation:off")
        : Markup.button.callback("Включить мотивацию", "group:motivation:on")
    ],
    [
      funEnabled
        ? Markup.button.callback("Отключить GIF/стикеры", "group:fun:off")
        : Markup.button.callback("Включить GIF/стикеры", "group:fun:on")
    ]
  ]);
}

async function askGroupDepartment(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;

  await replyTemporary(ctx, "Выберите департамент для этой группы:", groupDepartmentKeyboard(), 15000);
}

function mainMenuKeyboard(role?: string) {
  const rows = [
    [Markup.button.callback("План", "plan:view"), Markup.button.callback("Мои задачи", "tasks:mine")],
    [Markup.button.callback("Дэйлик", "daily:start"), Markup.button.callback("Блокер", "blocker:start")],
    [Markup.button.webApp("Открыть приложение", appUrl)]
  ];

  if (role === "lead") {
    rows.splice(2, 0, [Markup.button.callback("Сводка", "summary:view"), Markup.button.callback("Автосводка", "digest:view")]);
  }

  rows.push([Markup.button.callback("Привязка", "link:help")]);
  return Markup.inlineKeyboard(rows);
}

function planKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Мои задачи", "tasks:mine"), Markup.button.callback("Свободные шаги", "tasks:available")],
    [Markup.button.callback("Все шаги", "plan:steps")],
    [Markup.button.callback("Написать дэйлик", "daily:start"), Markup.button.callback("Сообщить блокер", "blocker:start")],
    [Markup.button.webApp("Открыть приложение", appUrl)]
  ]);
}

function taskKeyboard(stepId: string, status: string) {
  const statusRow =
    status === "done" || status === "canceled"
      ? [Markup.button.callback("Вернуть в работу", `task:status:${stepId}:in_progress`)]
      : [
          Markup.button.callback("В работу", `task:status:${stepId}:in_progress`),
          Markup.button.callback("Готово", `task:status:${stepId}:done`),
          Markup.button.callback("Отменить", `task:status:${stepId}:canceled`)
        ];
  return Markup.inlineKeyboard([statusRow, [Markup.button.callback("Есть блокер", `task:blocker:${stepId}`)]]);
}

function categoryHelp() {
  return [
    "Департаменты:",
    "/group_department system",
    "/group_department ml",
    "/group_department marketing",
    "/group_department sales",
    "/group_department erp",
    "/group_department security"
  ].join("\n");
}

function getTextFromMessage(ctx: Context) {
  const message = ctx.message;
  if (!message || !("text" in message)) return "";
  return message.text.trim();
}

function buildTelegramName(from: NonNullable<Context["from"]>) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || `Telegram ${from.id}`;
}

function buildTelegramMemberName(member: { id: number; first_name: string; last_name?: string; username?: string }) {
  return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.username || `Telegram ${member.id}`;
}

function localActivitySummary(messages: string[]) {
  const text = messages.join(" ").toLowerCase();
  const hasProgress = /(сделал|готов|закрыл|исправил|реализовал|проверил|добавил|собрал|done|fixed|ready)/i.test(text);
  const hasBlocker = /(не получается|ошибка|блокер|проблем|завис|сломал|не работает|bug|error|blocked)/i.test(text);
  const hasQuestion = /(\?|как|почему|можно ли|подскаж|help)/i.test(text);
  const score = Math.max(10, Math.min(100, 45 + (hasProgress ? 25 : 0) + (hasQuestion ? 10 : 0) - (hasBlocker ? 15 : 0)));
  const summary = [
    hasProgress ? "Есть признаки рабочего прогресса." : "Пока мало явных сообщений о завершенных задачах.",
    hasQuestion ? "Стажер задает вопросы и вовлекается в обсуждение." : "Вопросов в последних сообщениях немного.",
    hasBlocker ? "Встречаются признаки блокеров, тимлиду стоит проверить контекст." : "Критичных блокеров по чату не видно."
  ].join(" ");
  return { score, summary };
}

async function buildAiActivitySummary(messages: string[]) {
  const fallback = localActivitySummary(messages);
  const answer = await askGroqAssistant(`
Проанализируй активность стажера в Telegram-группе департамента.
Дай одну короткую сводку на русском: прогресс, вовлеченность, риски. Не выдумывай факты.
Сообщения:
${messages.join("\n")}
`);
  return answer ? { ...fallback, summary: answer.slice(0, 700) } : fallback;
}

async function trackGroupText(ctx: Context, text: string) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return;
  if (!ctx.from || ctx.from.is_bot) return;

  if (!text || text.startsWith("/")) return;

  const title = "title" in ctx.chat ? ctx.chat.title : "";
  const existingGroup = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  const category = (existingGroup?.category as Category | undefined) || detectCategoryFromGroupTitle(title);
  if (!category) return;

  const now = new Date();
  const chatId = String(ctx.chat.id);
  const telegramUserId = String(ctx.from.id);
  const username = ctx.from.username?.toLowerCase();

  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId },
    {
      chatId,
      title,
      category,
      active: true,
      lastActivityAt: now
    },
    { upsert: true, returnDocument: "after" }
  );
  if (!(await shouldUseGroupForDepartmentAnalytics(chatId, category))) return;

  let user = await UserModel.findOne({ telegramUserId });
  if (!user && username) user = await UserModel.findOne({ telegramUsername: username });
  if (!user) {
    user = await UserModel.create({
      name: buildTelegramName(ctx.from),
      role: "intern",
      category,
      avatarColor: randomAvatarColor(),
      firstLoginCompleted: false,
      emailVerified: false,
      telegramUserId,
      telegramUsername: username,
      telegramGroupChatId: chatId,
      registrationSource: "telegram_group",
      passwordHash: hashPassword(`telegram-${telegramUserId}-${Date.now()}`)
    });
    group.membersSeen += 1;
    await group.save();
  } else {
    user.name = user.name || buildTelegramName(ctx.from);
    user.telegramUserId = user.telegramUserId || telegramUserId;
    if (username) user.telegramUsername = username;
    if (!user.telegramGroupChatId || user.category === category) user.telegramGroupChatId = chatId;
    user.category = user.category || category;
  }

  await TelegramActivityModel.create({
    userId: user._id,
    chatId,
    messageId: ctx.message?.message_id,
    text: text.slice(0, 1000),
    messageAt: now
  });

  user.telegramActivityMessages = (user.telegramActivityMessages || 0) + 1;
  user.telegramLastGroupSeenAt = now;
  user.lastActiveAt = now;

  if (user.telegramActivityMessages % 10 === 0 || !user.telegramActivitySummary) {
    const recent = await TelegramActivityModel.find({ userId: user._id }).sort({ messageAt: -1 }).limit(12);
    const summary = await buildAiActivitySummary(recent.reverse().map((item) => item.text));
    user.telegramActivityScore = summary.score;
    user.telegramActivitySummary = summary.summary;
  }

  await user.save();

  if (user.telegramActivityMessages === 1) {
    await ctx.reply(
      `${buildTelegramName(ctx.from)}, я добавил вас в список стажеров департамента. Чтобы завершить регистрацию, откройте личный диалог с ботом и нажмите /start.`,
      Markup.inlineKeyboard([[Markup.button.url("Открыть бота", `https://t.me/${ctx.botInfo?.username || ""}`)]])
    );
  }
}

async function trackGroupMessage(ctx: Context) {
  await trackGroupText(ctx, getTextFromMessage(ctx));
}

function shouldAnswerGroupQuestion(ctx: Context, text: string) {
  if (!isGroupChat(ctx) || !text || text.startsWith("/")) return false;
  const normalized = text.toLowerCase();
  const botUsername = ctx.botInfo?.username?.toLowerCase();
  const mentionsBot = botUsername ? normalized.includes(`@${botUsername}`) : false;
  const repliesToBot =
    ctx.message &&
    "reply_to_message" in ctx.message &&
    ctx.message.reply_to_message?.from?.id === ctx.botInfo?.id;
  return Boolean(mentionsBot || repliesToBot);
}

function questionWithoutBotMention(ctx: Context, text: string) {
  const username = ctx.botInfo?.username;
  if (!username) return text.trim();
  return text.replace(new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), "").trim();
}

async function consumeGroupAiAllowance(ctx: Context) {
  if (!ctx.from) return { allowed: false, notify: false, name: "Коллега" };

  const telegramUserId = String(ctx.from.id);
  const username = ctx.from.username?.toLowerCase();
  let user = await UserModel.findOne({ telegramUserId });
  if (!user && username) user = await UserModel.findOne({ telegramUsername: username });
  if (!user) return { allowed: true, notify: false, name: buildTelegramName(ctx.from) };

  const now = new Date();
  const name = user.name || buildTelegramName(ctx.from);
  if (user.telegramAiCooldownUntil && user.telegramAiCooldownUntil.getTime() > now.getTime()) {
    return { allowed: false, notify: false, name };
  }

  const windowExpired =
    !user.telegramAiWindowStartedAt ||
    now.getTime() - user.telegramAiWindowStartedAt.getTime() >= telegramAiWindowMs;
  if (windowExpired) {
    user.telegramAiWindowStartedAt = now;
    user.telegramAiRepliesInWindow = 0;
    user.telegramAiCooldownUntil = undefined as any;
  }

  const limit = user.role === "intern" ? 6 : 12;
  if ((user.telegramAiRepliesInWindow || 0) >= limit) {
    user.telegramAiCooldownUntil = new Date(now.getTime() + telegramAiCooldownMs);
    await user.save();
    return { allowed: false, notify: true, name };
  }

  user.telegramAiRepliesInWindow = (user.telegramAiRepliesInWindow || 0) + 1;
  await user.save();
  return { allowed: true, notify: false, name };
}

async function answerGroupQuestion(ctx: Context, text: string) {
  if (!shouldAnswerGroupQuestion(ctx, text)) return false;

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
  const category = group?.category as Category | undefined;
  if (!category) {
    await ctx.reply("Сначала привяжите группу к департаменту. Тогда я получу рабочий контекст и смогу нормально отвечать, а не гадать по воздуху.", {
      reply_to_message_id: ctx.message?.message_id
    } as Parameters<Context["reply"]>[1]);
    return true;
  }
  if (!(await shouldUseGroupForDepartmentAnalytics(String(ctx.chat!.id), category))) {
    await replyTemporary(ctx, "Этот чат не выбран основным для департамента. Аналитика и AI-ответы идут из основного чата.", undefined, 12000);
    return true;
  }

  const question = questionWithoutBotMention(ctx, text);
  if (!question) {
    await ctx.reply("Я здесь. Сформулируй вопрос целиком, и разберёмся.", {
      reply_to_message_id: ctx.message?.message_id
    } as Parameters<Context["reply"]>[1]);
    return true;
  }

  const allowance = await consumeGroupAiAllowance(ctx);
  if (!allowance.allowed) {
    if (allowance.notify) {
      await ctx.reply(
        `${allowance.name}, давай немного выдохнем. За последние 10 минут вопросов уже много. Я возьму паузу на 20 минут, а ты пока собери их в один список — так будет полезнее и спокойнее для рабочего чата.`,
        {
          reply_to_message_id: ctx.message?.message_id
        } as Parameters<Context["reply"]>[1]
      );
    }
    return true;
  }

  await ctx.telegram.sendChatAction(ctx.chat!.id, "typing").catch(() => undefined);

  const [plans, interns, reports, recentActivities] = await Promise.all([
    findActivePlans(category, 5),
    UserModel.find({ role: "intern", category }).sort({ telegramActivityScore: -1 }).limit(8),
    ReportModel.find({ date: todayIso() }).sort({ createdAt: -1 }).limit(20),
    TelegramActivityModel.find({ chatId: String(ctx.chat!.id) }).sort({ messageAt: -1 }).limit(12)
  ]);
  const internIds = new Set(interns.map((user) => user.id));
  const departmentReports = reports.filter((report) => internIds.has(report.userId.toString()));
  const recentUserIds = [...new Set(recentActivities.map((activity) => activity.userId.toString()))];
  const recentUsers = recentUserIds.length ? await UserModel.find({ _id: { $in: recentUserIds } }) : [];
  const recentUserById = new Map(recentUsers.map((user) => [user.id, user.name]));
  const recentConversation = recentActivities
    .reverse()
    .map((activity) => `- ${recentUserById.get(activity.userId.toString()) || "Участник"}: ${activity.text.slice(0, 500)}`)
    .join("\n");

  const answer = await askGroqTelegramAssistant(`
Ответь участнику рабочей Telegram-группы.
Если вопрос относится к компании, проектам, людям или срокам, используй только рабочий контекст ниже.
Если это общий вопрос, отвечай на основе общих знаний.
Если вопрос неоднозначный, задай один короткий уточняющий вопрос.
Если выбираешь исполнителя, предложи не больше трёх подходящих стажёров и объясни выбор, не раскрывая внутренние AI-оценки.

Вопрос:
${question}

Рабочий контекст:
Департамент: ${categories[category]}
Активные планы:
${plans.map((plan) => `- ${plan.title}, дедлайн ${plan.adjustedDeadline}, версия #${plan.version || 1}`).join("\n") || "нет активных планов"}
Шаги:
${plans.flatMap((plan) => (plan.steps || []).map((step) => `- ${plan.title}: ${step.title}; статус ${stepStatusLabel(step.status)}; дедлайн ${step.deadline}; ${step.assignedTo ? "назначен" : "свободен"}`)).slice(0, 15).join("\n") || "нет шагов"}

Стажеры:
${interns.map((user) => `- ${user.name}; сообщений в группе ${user.telegramActivityMessages || 0}; ${user.telegramActivitySummary || "сводки нет"}`).join("\n") || "нет стажеров"}

Сегодняшние дэйлики:
${departmentReports.map((report) => `- ${report.yesterday}; план ${report.todayPlan}; блокеры ${report.blockers || "нет"}`).join("\n") || "нет дэйликов"}

Последние сообщения группы:
${recentConversation || "контекст переписки пока пуст"}
`);

  await ctx.reply(answer || "Сейчас AI-модель не ответила. Попробуй ещё раз чуть позже или сформулируй вопрос короче.", {
    reply_to_message_id: ctx.message?.message_id
  } as Parameters<Context["reply"]>[1]);
  return true;
}

async function trackNewGroupMembers(ctx: Context) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return;
  const message = ctx.message;
  if (!message || !("new_chat_members" in message)) return;

  const title = "title" in ctx.chat ? ctx.chat.title : "";
  const chatId = String(ctx.chat.id);
  const existingGroup = await TelegramGroupModel.findOne({ chatId });
  const category = (existingGroup?.category as Category | undefined) || detectCategoryFromGroupTitle(title);

  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId },
    {
      chatId,
      title,
      ...(category ? { category } : {}),
      active: true,
      lastActivityAt: new Date()
    },
    { upsert: true, returnDocument: "after" }
  );
  if (category && !(await shouldUseGroupForDepartmentAnalytics(chatId, category))) return;

  let created = 0;
  for (const member of message.new_chat_members) {
    if (member.is_bot) continue;

    const telegramUserId = String(member.id);
    const username = member.username?.toLowerCase();
    let user = await UserModel.findOne({ telegramUserId });
    if (!user && username) user = await UserModel.findOne({ telegramUsername: username });
    if (!user) {
      user = await UserModel.create({
        name: buildTelegramMemberName(member),
        role: "intern",
        category,
        avatarColor: randomAvatarColor(),
        firstLoginCompleted: false,
        emailVerified: false,
        telegramUserId,
        telegramUsername: username,
        telegramGroupChatId: category ? chatId : undefined,
        registrationSource: "telegram_group",
        passwordHash: hashPassword(`telegram-${telegramUserId}-${Date.now()}`)
      });
      created += 1;
    } else {
      user.telegramUserId = user.telegramUserId || telegramUserId;
      if (username) user.telegramUsername = username;
      if (!user.category && category) user.category = category;
      if (!user.telegramGroupChatId && category) user.telegramGroupChatId = chatId;
      await user.save();
    }
  }

  if (created > 0) {
    group.membersSeen += created;
    await group.save();
  }

  if (!category) {
    await ctx.reply("Вижу новых участников, но группа еще не привязана к департаменту. Администратор может выбрать департамент командой /group_department.");
    return;
  }

  await ctx.reply(
    `Добавил новых участников в предварительный список департамента: ${categories[category]}. Чтобы завершить регистрацию, им нужно открыть личку с ботом и нажать /start.`,
    Markup.inlineKeyboard([[Markup.button.url("Открыть бота", `https://t.me/${ctx.botInfo?.username || ""}`)]])
  );
}

async function handleBotChatMemberUpdate(ctx: Context) {
  const update = ctx.update as {
    my_chat_member?: {
      chat?: { id: number | string; type?: string; title?: string };
      new_chat_member?: { status?: string };
    };
  };
  const event = update.my_chat_member;
  const chat = event?.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const chatId = String(chat.id);
  const title = chat.title || "Telegram group";
  const status = event?.new_chat_member?.status;
  if (status === "left" || status === "kicked") {
    await deactivateTelegramGroup(chatId);
    return;
  }

  if (status === "member" || status === "administrator") {
    await markTelegramGroupActive(chatId, title, detectCategoryFromGroupTitle(title));
  }
}

async function applyGroupDepartment(ctx: Context, category: Category) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);
  deleteCallbackSourceLater(ctx);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Эта команда работает только в группе департамента.");
    return;
  }

  const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId: String(ctx.chat.id) },
    {
      chatId: String(ctx.chat.id),
      title,
      category,
      active: true,
      lastActivityAt: new Date()
    },
    { upsert: true, returnDocument: "after" }
  );

  await replyTemporary(
    ctx,
    `Группа привязана к департаменту: ${categories[category]}. Участников вижу: ${group.membersSeen}.`,
    groupActionsKeyboard(group.motivationEnabled, group.funEnabled)
  );
}

async function setGroupDepartment(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Эта команда работает только в группе департамента.");
    return;
  }

  const text = getTextFromMessage(ctx);
  const category = parseCategoryAlias(text.split(/\s+/)[1]);
  if (!category) {
    await replyTemporary(ctx, categoryHelp(), undefined, 15000);
    return;
  }

  const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId: String(ctx.chat.id) },
    {
      chatId: String(ctx.chat.id),
      title,
      category,
      active: true,
      lastActivityAt: new Date()
    },
    { upsert: true, returnDocument: "after" }
  );

  await replyTemporary(ctx, `Группа привязана к департаменту: ${categories[category]}. Участников вижу: ${group.membersSeen}.`);
}

async function sendGroupStatus(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Эта команда работает только в группе департамента.");
    return;
  }

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  if (!group?.category) {
    await replyTemporary(ctx, `Группа еще не привязана к департаменту.\n${categoryHelp()}`, undefined, 15000);
    return;
  }

  const members = await UserModel.countDocuments({ telegramGroupChatId: String(ctx.chat.id), role: "intern" });
  const plans = await findActivePlans(group.category as Category, 5);
  await replyTemporary(ctx,
    [
      `Департамент: ${categories[group.category as Category]}`,
      `Стажеров найдено по чату: ${members}`,
      `Мотивация: ${group.motivationEnabled ? "включена" : "выключена"}`,
      `GIF/стикеры: ${group.funEnabled ? `включены, сохранено ${group.funMedia.length}` : `выключены, сохранено ${group.funMedia.length}`}`,
      plans.length ? `Активных планов: ${plans.length}. Последний: ${plans[0].title}, дедлайн ${plans[0].adjustedDeadline}` : "План департамента еще не создан"
    ].join("\n"),
    undefined,
    15000
  );
}

async function setGroupMotivation(ctx: Context, enabled: boolean) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);
  deleteCallbackSourceLater(ctx);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Эта команда работает только в группе департамента.");
    return;
  }

  const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
  const category = detectCategoryFromGroupTitle(title);
  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId: String(ctx.chat.id) },
    {
      chatId: String(ctx.chat.id),
      title,
      ...(category ? { category } : {}),
      active: true,
      motivationEnabled: enabled
    },
    { upsert: true, returnDocument: "after" }
  );

  await replyTemporary(ctx, `Будничная мотивация ${group.motivationEnabled ? "включена" : "выключена"}.`);
}

function funMediaFromReply(ctx: Context): TelegramFunMedia | undefined {
  const message = ctx.message;
  if (!message || !("reply_to_message" in message) || !message.reply_to_message) return undefined;

  const replied = message.reply_to_message;
  if ("animation" in replied && replied.animation) {
    return {
      type: "animation",
      fileId: replied.animation.file_id,
      fileUniqueId: replied.animation.file_unique_id
    };
  }
  if ("sticker" in replied && replied.sticker) {
    return {
      type: "sticker",
      fileId: replied.sticker.file_id,
      fileUniqueId: replied.sticker.file_unique_id
    };
  }
  return undefined;
}

async function sendTelegramFunMedia(bot: Telegraf, chatId: string, media: TelegramFunMedia, replyToMessageId?: number) {
  const options = replyToMessageId ? ({ reply_to_message_id: replyToMessageId } as any) : undefined;
  if (media.type === "animation") {
    await bot.telegram.sendAnimation(chatId, media.fileId, options);
    return;
  }
  await bot.telegram.sendSticker(chatId, media.fileId, options);
}

async function addGroupFunMedia(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  const media = funMediaFromReply(ctx);
  if (!media) {
    await replyTemporary(ctx, "Ответьте командой /fun_add на GIF или стикер, который бот сможет использовать.", undefined, 15000);
    return;
  }

  const title = ctx.chat && "title" in ctx.chat ? ctx.chat.title : "Telegram group";
  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId: String(ctx.chat!.id) },
    {
      $set: {
        chatId: String(ctx.chat!.id),
        title,
        active: true,
        funEnabled: true,
        lastActivityAt: new Date()
      }
    },
    { upsert: true, returnDocument: "after" }
  );

  const mediaItems = group.funMedia as unknown as TelegramFunMedia[];
  const duplicate = mediaItems.some(
    (item) => (media.fileUniqueId && item.fileUniqueId === media.fileUniqueId) || item.fileId === media.fileId
  );
  if (!duplicate) {
    group.funMedia.push({
      ...media,
      addedByTelegramUserId: ctx.from ? String(ctx.from.id) : undefined,
      addedAt: new Date()
    });
    if (group.funMedia.length > 30) group.funMedia.splice(0, group.funMedia.length - 30);
  }
  if (!group.funNextReplyAt) group.funNextReplyAt = nextRandomFunReplyAt();
  await group.save();

  await replyTemporary(
    ctx,
    duplicate
      ? `Этот файл уже сохранен. В медиатеке: ${group.funMedia.length}.`
      : `Сохранено. В медиатеке: ${group.funMedia.length}. GIF/стикеры включены.`,
    undefined,
    12000
  );
}

async function setGroupFun(ctx: Context, enabled: boolean) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);
  deleteCallbackSourceLater(ctx);

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
  if (!group) {
    await replyTemporary(ctx, "Сначала привяжите группу к департаменту.");
    return;
  }
  if (enabled && !group.funMedia.length) {
    await replyTemporary(ctx, "Сначала ответьте командой /fun_add на GIF или стикер.", undefined, 15000);
    return;
  }

  group.funEnabled = enabled;
  group.funNextReplyAt = enabled ? nextRandomFunReplyAt() : (undefined as any);
  await group.save();
  await replyTemporary(ctx, `GIF и стикеры ${enabled ? "включены" : "выключены"}.`);
}

async function sendGroupFunStatus(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
  if (!group) {
    await replyTemporary(ctx, "Сначала привяжите группу к департаменту.");
    return;
  }

  await replyTemporary(
    ctx,
    [
      `GIF/стикеры: ${group.funEnabled ? "включены" : "выключены"}`,
      `Сохранено файлов: ${group.funMedia.length}`,
      group.funNextReplyAt
        ? `Следующий случайный ответ: примерно ${group.funNextReplyAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}`
        : "",
      "Чтобы добавить файл, ответьте на GIF или стикер командой /fun_add."
    ]
      .filter(Boolean)
      .join("\n"),
    undefined,
    20000
  );
}

async function clearGroupFunMedia(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
  if (!group) return;
  group.funMedia.splice(0, group.funMedia.length);
  group.funEnabled = false;
  group.funNextReplyAt = undefined as any;
  await group.save();
  await replyTemporary(ctx, "Медиатека GIF и стикеров очищена.");
}

async function handleGroupDepartmentCommand(ctx: Context) {
  const text = getTextFromMessage(ctx);
  const category = parseCategoryAlias(text.split(/\s+/)[1]);
  if (!category) {
    await askGroupDepartment(ctx);
    return;
  }
  await applyGroupDepartment(ctx, category);
}

async function sendGroupStatusWithButtons(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);
  deleteCallbackSourceLater(ctx, 15000);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Эта команда работает только в группе департамента.");
    return;
  }

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  if (!group?.category) {
    await replyTemporary(ctx, "Группа еще не привязана к департаменту.", groupDepartmentKeyboard(), 15000);
    return;
  }

  const members = await UserModel.countDocuments({ telegramGroupChatId: String(ctx.chat.id), role: "intern" });
  const plans = await findActivePlans(group.category as Category, 5);
  await replyTemporary(ctx,
    [
      `Департамент: ${categories[group.category as Category]}`,
      `Стажеров найдено по чату: ${members}`,
      `Мотивация: ${group.motivationEnabled ? "включена" : "выключена"}`,
      `GIF/стикеры: ${group.funEnabled ? `включены, сохранено ${group.funMedia.length}` : `выключены, сохранено ${group.funMedia.length}`}`,
      plans.length ? `Активных планов: ${plans.length}. Последний: ${plans[0].title}, дедлайн ${plans[0].adjustedDeadline}` : "План департамента еще не создан"
    ].join("\n"),
    groupActionsKeyboard(group.motivationEnabled, group.funEnabled),
    15000
  );
}

async function buildMotivationMessage(category: Category) {
  const [plans, interns] = await Promise.all([
    findActivePlans(category, 5),
    UserModel.find({ role: "intern", category }).sort({ telegramActivityScore: -1 }).limit(5)
  ]);
  const openSteps = plans
    .flatMap((plan) =>
      (plan.steps || [])
        .filter((step) => step.status !== "done" && step.status !== "canceled")
        .map((step) => ({ plan, step }))
    )
    .slice(0, 6);
  const activeNames = interns.filter((user) => (user.telegramActivityMessages || 0) > 0).map((user) => user.name).slice(0, 4);

  const planLines = plans.map((plan) => {
    const steps = plan.steps || [];
    const open = steps.filter((step) => step.status !== "done" && step.status !== "canceled").length;
    const done = steps.filter((step) => step.status === "done").length;
    return `- ${plan.title}: дедлайн ${formatShortDate(plan.adjustedDeadline)}, открыто ${open}/${steps.length}, готово ${done}.`;
  });
  const stepLines = openSteps.slice(0, 4).map(({ plan, step }) => `- ${plan.title}: ${step.title} до ${formatShortDate(step.deadline)}.`);

  return [
    `Доброе утро, ${categories[category]}.`,
    plans.length ? [`Активных планов: ${plans.length}.`, ...planLines].join("\n") : "Активных планов пока нет, держим фокус на задачах департамента.",
    stepLines.length ? ["Ближайший фокус по шагам:", ...stepLines].join("\n") : "",
    activeNames.length ? `Вижу активность: ${activeNames.join(", ")}.` : "Пишите вопросы и блокеры в чат, так тимлид быстрее поможет.",
    "Зафиксируйте прогресс в дэйлике и сразу подсвечивайте блокеры."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function sendWeekdayGroupMotivation() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");

  const now = new Date();
  const weekday = now.getUTCDay();
  if (weekday === 0 || weekday === 6) return { sent: 0, skipped: "weekend" };

  const dayKey = now.toISOString().slice(0, 10);
  const groups = await findAllDepartmentTelegramGroups({ motivationOnly: true });

  let sent = 0;
  for (const group of groups) {
    const lastSentDay = group.motivationLastSentAt?.toISOString().slice(0, 10);
    if (lastSentDay === dayKey) continue;

    try {
      const [plansCount, internsCount] = await Promise.all([
        PlanModel.countDocuments({ category: group.category, ...activePlanFilter }),
        UserModel.countDocuments({ role: "intern", category: group.category })
      ]);
      if (!plansCount || !internsCount || !group.chatId?.trim()) continue;

      const message = await buildMotivationMessage(group.category as Category);
      await bot.telegram.sendMessage(group.chatId, message);
      const media = randomItem(group.funMedia as unknown as TelegramFunMedia[]);
      if (group.funEnabled && media) {
        try {
          await sendTelegramFunMedia(bot, group.chatId, media);
        } catch (error) {
          console.error("Telegram motivation fun media error", error);
        }
      }
      group.motivationLastSentAt = now;
      await group.save();
      sent += 1;
    } catch (error) {
      console.error("Telegram weekday motivation error", error);
      if (group.chatId) await deactivateGroupAfterSendError(group.chatId, error);
    }
  }

  return { sent };
}

async function sendGroupMotivationNow(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Мотивация отправляется только в группе департамента.");
    return;
  }

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  if (!group?.category) {
    await replyTemporary(ctx, "Сначала привяжите группу к департаменту.", groupDepartmentKeyboard(), 15000);
    return;
  }

  const message = await buildMotivationMessage(group.category as Category);
  await ctx.reply(message);
  const media = randomItem(group.funMedia as unknown as TelegramFunMedia[]);
  const bot = getTelegramBot();
  if (bot && group.funEnabled && media) {
    try {
      await sendTelegramFunMedia(bot, group.chatId, media);
    } catch (error) {
      console.error("Telegram manual motivation fun media error", error);
    }
  }
}

export async function sendRandomTelegramFunReply() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");

  const now = new Date();
  const groups = (await findAllDepartmentTelegramGroups()).filter(
    (group) => group.funEnabled && group.funMedia.length > 0
  );
  let scheduled = 0;
  let sent = 0;
  let withoutRecentMessages = 0;

  for (const group of groups) {
    if (!group.funNextReplyAt) {
      group.funNextReplyAt = nextRandomFunReplyAt(now);
      await group.save();
      scheduled += 1;
      continue;
    }
    if (group.funNextReplyAt.getTime() > now.getTime()) continue;

    const nextReplyAt = nextRandomFunReplyAt(new Date(now.getTime() + 12 * 60 * 60 * 1000));
    const claimed = await TelegramGroupModel.findOneAndUpdate(
      {
        _id: group._id,
        active: { $ne: false },
        funEnabled: true,
        funNextReplyAt: { $lte: now }
      },
      {
        $set: {
          funNextReplyAt: nextReplyAt
        }
      },
      { returnDocument: "after" }
    );
    if (!claimed) continue;

    const recentActivities = await TelegramActivityModel.find({
      chatId: claimed.chatId,
      messageId: { $gte: 1 },
      funRepliedAt: { $exists: false },
      messageAt: { $gte: new Date(now.getTime() - funReplyLookbackMs) }
    })
      .sort({ messageAt: -1 })
      .limit(200);

    const activitiesByUser = new Map<string, typeof recentActivities>();
    for (const activity of recentActivities) {
      const userId = activity.userId.toString();
      activitiesByUser.set(userId, [...(activitiesByUser.get(userId) || []), activity]);
    }
    const selectedUserActivities = randomItem(Array.from(activitiesByUser.values()));
    const activity = selectedUserActivities ? randomItem(selectedUserActivities) : undefined;
    const media = randomItem(claimed.funMedia as unknown as TelegramFunMedia[]);
    if (!activity?.messageId || !media) {
      withoutRecentMessages += 1;
      continue;
    }

    try {
      await sendTelegramFunMedia(bot, claimed.chatId, media, activity.messageId);
      await TelegramActivityModel.updateOne({ _id: activity._id }, { $set: { funRepliedAt: now } });
      claimed.funLastReplyAt = now;
      await claimed.save();
      sent += 1;
    } catch (error) {
      console.error("Telegram random fun reply error", error);
      await deactivateGroupAfterSendError(claimed.chatId, error);
    }
  }

  return { groups: groups.length, scheduled, sent, withoutRecentMessages };
}

async function buildGroupDailyDigest(category: Category) {
  const [plans, interns, todayReports] = await Promise.all([
    findActivePlans(category, 5),
    UserModel.find({ role: "intern", category }).sort({ telegramActivityScore: -1 }),
    ReportModel.find({ date: todayIso() })
  ]);

  const internIds = new Set(interns.map((user) => user.id));
  const departmentReports = todayReports.filter((report) => internIds.has(report.userId.toString()));
  const reportUserIds = new Set(departmentReports.map((report) => report.userId.toString()));
  const missing = interns.filter((user) => !reportUserIds.has(user.id)).slice(0, 6);
  const blockers = departmentReports.filter((report) => report.blockers?.trim()).slice(0, 4);
  const steps = plans.flatMap((plan) => plan.steps || []);
  const openSteps = steps.filter((step) => step.status !== "done" && step.status !== "canceled");
  const doneSteps = steps.filter((step) => step.status === "done");
  const avgScore = departmentReports.length
    ? Math.round(departmentReports.reduce((sum, report) => sum + (report.aiReview?.productivityScore || 0), 0) / departmentReports.length)
    : 0;

  return [
    `Дневной дайджест: ${categories[category]}`,
    plans.length ? `Активных планов: ${plans.length}. ${plans.map((plan) => plan.title).slice(0, 3).join("; ")}` : "Активный план пока не создан.",
    plans.length ? `Шаги по всем планам: ${doneSteps.length}/${steps.length} готово, ${openSteps.length} открыто.` : "",
    `Дэйлики сегодня: ${departmentReports.length}/${interns.length}`,
    departmentReports.length ? `Средняя продуктивность по AI: ${avgScore}%` : "AI еще не получил сегодняшние дэйлики.",
    missing.length ? `Еще ждут дэйлик: ${missing.map((user) => user.name).join(", ")}` : "Все найденные стажеры уже отправили дэйлик.",
    blockers.length ? `Блокеры: ${blockers.map((report) => report.blockers.slice(0, 90)).join("; ")}` : "Критичных блокеров в сегодняшних отчетах нет.",
    openSteps.length ? `Фокус: ${openSteps.slice(0, 3).map((step) => step.title).join("; ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function sendGroupDailyDigestNow(ctx: Context) {
  if (!(await requireGroupAdmin(ctx))) return;
  deleteIncomingMessageLater(ctx);

  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await replyTemporary(ctx, "Дайджест отправляется только в группе департамента.");
    return;
  }

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  if (!group?.category) {
    await replyTemporary(ctx, "Сначала привяжите группу к департаменту.", groupDepartmentKeyboard(), 15000);
    return;
  }

  await ctx.reply(await buildGroupDailyDigest(group.category as Category));
}

export async function sendWeekdayGroupDailyDigests() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");
  if (!isWeekdayUtc()) return { sent: 0, skipped: "weekend" };

  const groups = await findAllDepartmentTelegramGroups({ motivationOnly: true });

  let sent = 0;
  for (const group of groups) {
    if (isSameIsoDay(group.groupDigestLastSentAt)) continue;
    try {
      await bot.telegram.sendMessage(group.chatId, await buildGroupDailyDigest(group.category as Category));
      group.groupDigestLastSentAt = new Date();
      await group.save();
      sent += 1;
    } catch (error) {
      console.error("Telegram group digest error", error);
      if (group.chatId) await deactivateGroupAfterSendError(group.chatId, error);
    }
  }

  return { sent };
}

export async function sendWeekdayPersonalFocus() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");
  if (!isWeekdayUtc()) return { sent: 0, skipped: "weekend" };

  const interns = await UserModel.find({
    role: "intern",
    category: { $exists: true },
    telegramChatId: { $type: "string", $ne: "" }
  });

  let sent = 0;
  for (const user of interns) {
    if (isSameIsoDay(user.telegramFocusLastSentAt)) continue;
    if (!user.telegramChatId?.trim()) continue;
    const plans = await findActivePlans(user.category as Category, 5);
    if (!plans.length) continue;

    const assigned = plans.flatMap((plan) =>
      (plan.steps || [])
        .filter((step) => step.assignedTo?.toString() === user.id && step.status !== "done" && step.status !== "canceled")
        .map((step) => ({ plan, step }))
    );
    const available = plans.flatMap((plan) =>
      (plan.steps || [])
        .filter((step) => !step.assignedTo && step.status !== "done" && step.status !== "canceled")
        .map((step) => ({ plan, step }))
    );
    const focus = assigned[0] || available[0];
    if (!focus) continue;

    const message = [
      `Фокус дня по плану "${focus.plan.title}"`,
      assigned.length ? `Ваш текущий шаг: ${focus.step.title}` : `Можно взять свободный шаг: ${focus.step.title}`,
      `Дедлайн: ${focus.step.deadline}`,
      "Если есть блокер, лучше зафиксировать его сразу."
    ].join("\n");

    try {
      await bot.telegram.sendMessage(
        user.telegramChatId,
        message,
        Markup.inlineKeyboard([
          [Markup.button.callback(assigned.length ? "Мои задачи" : "Свободные шаги", assigned.length ? "tasks:mine" : "tasks:available")],
          [Markup.button.callback("Написать дэйлик", "daily:start"), Markup.button.callback("Блокер", "blocker:start")]
        ])
      );
      user.telegramFocusLastSentAt = new Date();
      await user.save();
      sent += 1;
    } catch (error) {
      console.error("Telegram personal focus error", error);
    }
  }

  return { sent };
}

export async function sendWeekdayReportReminders() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");
  if (!isWeekdayUtc()) return { sent: 0, skipped: "weekend" };

  const interns = await UserModel.find({
    role: "intern",
    category: { $exists: true },
    telegramChatId: { $type: "string", $ne: "" }
  });
  const reports = await ReportModel.find({ date: todayIso(), userId: { $in: interns.map((user) => user._id) } });
  const reportedIds = new Set(reports.map((report) => report.userId.toString()));

  let sent = 0;
  for (const user of interns) {
    if (reportedIds.has(user.id) || isSameIsoDay(user.telegramReportReminderLastSentAt)) continue;
    if (!user.telegramChatId?.trim()) continue;
    try {
      await bot.telegram.sendMessage(
        user.telegramChatId,
        "Напоминание: сегодня еще нет вашего дэйлика. Коротко зафиксируйте, что сделали, план и блокеры — это помогает тимлиду быстрее понимать прогресс.",
        Markup.inlineKeyboard([[Markup.button.callback("Написать дэйлик", "daily:start"), Markup.button.callback("Мои задачи", "tasks:mine")]])
      );
      user.telegramReportReminderLastSentAt = new Date();
      await user.save();
      sent += 1;
    } catch (error) {
      console.error("Telegram report reminder error", error);
    }
  }

  return { sent };
}

export async function sendTelegramProductivityAutomation() {
  const [focus, reminders, groupDigests] = await Promise.all([
    sendWeekdayPersonalFocus(),
    sendWeekdayReportReminders(),
    sendWeekdayGroupDailyDigests()
  ]);

  return {
    focus,
    reminders,
    groupDigests
  };
}

export async function notifyDepartmentPlanChange(input: {
  planId: string;
  category: Category;
  actorId: string;
  type: "plan_created" | "plan_updated" | "step_added" | "step_updated" | "step_assigned" | "deadline_changed";
  title: string;
  summary: string;
  stepId?: string;
}) {
  const recipients = await UserModel.find({
    role: "intern",
    category: input.category,
    telegramChatId: { $type: "string", $ne: "" }
  });

  const change = await PlanChangeModel.create({
    planId: input.planId,
    category: input.category,
    actorId: input.actorId,
    type: input.type,
    title: input.title,
    summary: input.summary,
    stepId: input.stepId,
    recipientsCount: recipients.length
  });

  const bot = getTelegramBot();
  if (!bot) return change;

  const message = [
    "Изменение в плане департамента",
    `Департамент: ${categories[input.category]}`,
    `Событие: ${input.title}`,
    input.summary
  ].join("\n");

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("Посмотреть план", "plan:view"), Markup.button.callback("Мои задачи", "tasks:mine")],
    [Markup.button.webApp("Открыть приложение", appUrl)]
  ]);

  const groups = await findDepartmentTelegramGroups(input.category);

  const groupMessage = [
    input.type === "plan_created" ? "В департаменте опубликован новый план." : "План департамента обновлен.",
    `Департамент: ${categories[input.category]}`,
    input.summary,
    "",
    "Стажеры: откройте личный чат с ботом и нажмите «Свободные шаги», чтобы выбрать задачу для работы."
  ].join("\n");

  let groupSent = 0;
  for (const group of groups) {
    try {
      if (!group.chatId?.trim()) continue;
      await bot.telegram.sendMessage(group.chatId, groupMessage);
      groupSent += 1;
    } catch (error) {
      console.error("Telegram group plan change notification error", error);
      if (group.chatId) await deactivateGroupAfterSendError(group.chatId, error);
    }
  }

  if (groupSent > 0) {
    await PlanModel.updateOne({ _id: input.planId }, { $set: { telegramAnnouncedAt: new Date() } });
  }

  for (const user of recipients) {
    try {
      if (!user.telegramChatId?.trim()) continue;
      await bot.telegram.sendMessage(user.telegramChatId, message, buttons);
    } catch (error) {
      console.error("Telegram plan change notification error", error);
    }
  }

  return change;
}

export async function sendTelegramRecoveryBroadcast() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");

  const groups = await findAllDepartmentTelegramGroups();

  let motivationMessages = 0;
  for (const group of groups) {
    try {
      if (!group.chatId?.trim() || !group.category) continue;
      await bot.telegram.sendMessage(group.chatId, await buildMotivationMessage(group.category as Category));
      const media = randomItem(group.funMedia as unknown as TelegramFunMedia[]);
      if (group.funEnabled && media) await sendTelegramFunMedia(bot, group.chatId, media);
      motivationMessages += 1;
    } catch (error) {
      console.error("Telegram manual motivation broadcast error", error);
      if (group.chatId) await deactivateGroupAfterSendError(group.chatId, error);
    }
  }

  const pendingPlans = await PlanModel.find({
    status: { $in: ["draft", "approved"] },
    $or: [{ telegramAnnouncedAt: { $exists: false } }, { telegramAnnouncedAt: null }]
  }).sort({ category: 1, createdAt: -1 });

  let planAnnouncementMessages = 0;
  let announcedPlans = 0;
  for (const plan of pendingPlans) {
    const planGroups = groups.filter((group) => group.category === plan.category);
    if (!planGroups.length) continue;

    const message = [
      "План департамента доступен для работы.",
      `Департамент: ${categories[plan.category as Category]}`,
      `План: ${plan.title}`,
      `Дедлайн: ${plan.adjustedDeadline}`,
      `Шагов: ${plan.steps.length}`,
      "",
      "Стажеры: откройте личный чат с ботом и нажмите «Свободные шаги», чтобы выбрать задачу."
    ].join("\n");

    let sentForPlan = 0;
    for (const group of planGroups) {
      try {
        if (!group.chatId?.trim()) continue;
        await bot.telegram.sendMessage(group.chatId, message);
        sentForPlan += 1;
        planAnnouncementMessages += 1;
      } catch (error) {
        console.error("Telegram manual plan announcement error", error);
        if (group.chatId) await deactivateGroupAfterSendError(group.chatId, error);
      }
    }

    if (sentForPlan > 0) {
      plan.telegramAnnouncedAt = new Date();
      await plan.save();
      announcedPlans += 1;
    }
  }

  return {
    groups: groups.length,
    motivationMessages,
    pendingPlans: pendingPlans.length,
    announcedPlans,
    planAnnouncementMessages
  };
}

async function getLinkedUser(ctx: Context) {
  if (!ctx.chat?.id) return null;
  return UserModel.findOne({ telegramChatId: String(ctx.chat.id) });
}

async function requireLinkedUser(ctx: Context) {
  const user = await getLinkedUser(ctx);
  if (!user) {
    await ctx.reply("Сначала привяжите Telegram: /link ваш@email", Markup.inlineKeyboard([[Markup.button.callback("Как привязать", "link:help")]]));
    return null;
  }
  return user;
}

async function transcribeTelegramVoice(ctx: Context) {
  const message = ctx.message;
  if (!message || !("voice" in message)) return undefined;

  const fileLink = await ctx.telegram.getFileLink(message.voice.file_id);
  const response = await fetch(fileLink);
  if (!response.ok) return undefined;

  return transcribeAudio({
    buffer: await response.arrayBuffer(),
    filename: "telegram-voice.ogg",
    mimeType: message.voice.mime_type || "audio/ogg"
  });
}

function looksLikeTaskQuestion(text: string) {
  return /(мо(и|я)|мне|назнач|задач|шаг|делать|работать)/i.test(text) && /(шаг|задач|назнач|план)/i.test(text);
}

function looksLikePlanQuestion(text: string) {
  return /(план|дедлайн|этап|проект|изменени)/i.test(text);
}

async function answerPrivateVoiceQuestion(ctx: Context, text: string) {
  const user = await requireLinkedUser(ctx);
  if (!user) return;

  if (looksLikeTaskQuestion(text)) {
    await sendMyTasks(ctx);
    return;
  }

  if (looksLikePlanQuestion(text)) {
    await sendPlan(ctx);
    return;
  }

  const plans = user.category ? await findActivePlans(user.category as Category, 5) : [];
  const assignedSteps = plans.flatMap((plan) => (plan.steps || []).filter((step) => step.assignedTo?.toString() === user.id).map((step) => ({ plan, step })));
  const allSteps = plans.flatMap((plan) => (plan.steps || []).map((step) => ({ plan, step }))).slice(0, 10);
  const context = [
    `Пользователь: ${user.name}`,
    `Роль: ${user.role}`,
    `Департамент: ${user.category ? categories[user.category as Category] : "не выбран"}`,
    plans.length ? `Активные планы:\n${plans.map((plan) => `- ${plan.title}, дедлайн ${plan.adjustedDeadline}`).join("\n")}` : "Активных планов нет",
    assignedSteps.length
      ? `Назначенные шаги:\n${assignedSteps.map(({ plan, step }, index) => `${index + 1}. ${plan.title}: ${step.title}; дедлайн ${step.deadline}; статус ${stepStatusLabel(step.status)}`).join("\n")}`
      : "Назначенных лично шагов нет",
    allSteps.length ? `Все шаги планов:\n${allSteps.map(({ plan, step }, index) => `${index + 1}. ${plan.title}: ${step.title}; ${stepStatusLabel(step.status)}`).join("\n")}` : ""
  ].join("\n");

  const answer = await askGroqAssistant(`
Пользователь задал голосовой вопрос Telegram-боту mini ERP.
Вопрос после распознавания: ${text}

Контекст из базы:
${context}

Ответь кратко по-русски. Если пользователь спрашивает про данные, которых нет в контексте, прямо скажи, что данных нет.
`);

  await ctx.reply(answer || "Я распознал голос, но не понял точный запрос. Можно спросить: какие шаги мне назначены, какой план департамента или какой дедлайн?");
}

async function handleVoiceMessage(ctx: Context) {
  const transcript = await transcribeTelegramVoice(ctx);
  if (!transcript) {
    await ctx.reply("Не смог распознать голосовое. Проверьте GROQ_API_KEY и GROQ_WHISPER_MODEL.");
    return;
  }

  if (isGroupChat(ctx)) {
    await trackGroupText(ctx, transcript);
    await ctx.reply(`Голосовое распознано и учтено в активности:\n${transcript.slice(0, 700)}`, {
      reply_to_message_id: ctx.message?.message_id
    } as Parameters<Context["reply"]>[1]);
    return;
  }

  if (isPrivateChat(ctx)) {
    await ctx.reply(`Распознал: ${transcript}`);
    await answerPrivateVoiceQuestion(ctx, transcript);
  }
}

async function sendMyTasks(ctx: Context) {
  if (!(await requirePrivateChat(ctx, "Личные задачи доступны только в личном чате с ботом."))) return;
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  if (!user.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plans = await findActivePlans(user.category as Category, 5);
  if (!plans.length) {
    await ctx.reply("План департамента еще не создан.", mainMenuKeyboard(user.role));
    return;
  }

  const assignedSteps = plans.flatMap((plan) =>
    (plan.steps || [])
      .filter((step) => step.assignedTo?.toString() === user.id)
      .map((step) => ({ plan, step }))
  );
  if (!assignedSteps.length) {
    await ctx.reply(
      "Пока нет назначенных лично вам шагов. Можно выбрать свободный шаг из плана департамента.",
      Markup.inlineKeyboard([[Markup.button.callback("Свободные шаги", "tasks:available"), Markup.button.callback("Все шаги", "plan:steps")]])
    );
    return;
  }

  await ctx.reply(`Ваши задачи по активным планам:`);
  for (const { plan, step } of assignedSteps.slice(0, 10)) {
    const status = stepStatusLabel(step.status);
    await ctx.reply(
      [`План: ${plan.title}`, `${step.title}`, step.description ? `Описание: ${step.description}` : "", `Дедлайн: ${step.deadline}`, `Статус: ${status}`].filter(Boolean).join("\n"),
      taskKeyboard(step._id.toString(), step.status)
    );
  }
}

async function sendAllPlanSteps(ctx: Context) {
  if (!(await requirePrivateChat(ctx, "Личные шаги плана доступны только в личном чате с ботом."))) return;
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  if (!user.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plans = await findActivePlans(user.category as Category, 5);
  if (!plans.length) {
    await ctx.reply("План департамента еще не создан.", mainMenuKeyboard(user.role));
    return;
  }

  const steps = plans.flatMap((plan) => (plan.steps || []).map((step) => ({ plan, step }))).slice(0, 15);
  const lines = steps.map((step, index) => {
    const status = stepStatusLabel(step.step.status);
    const mine = step.step.assignedTo?.toString() === user.id ? " | ваше" : "";
    const assigned = step.step.assignedTo && step.step.assignedTo.toString() !== user.id ? " | уже назначен" : "";
    return `${index + 1}. ${step.plan.title}: ${step.step.title} - до ${step.step.deadline} | ${status}${mine}${assigned}`;
  });

  const claimRows = steps
    .filter(({ step }) => !step.assignedTo && step.status !== "done" && step.status !== "canceled")
    .slice(0, 8)
    .map(({ step }, index) => [Markup.button.callback(`Взять шаг ${index + 1}`, `task:claim:${step._id.toString()}`)]);

  await ctx.reply(
    lines.length ? [`Активные планы: ${plans.length}`, ...lines].join("\n") : "В планах пока нет шагов.",
    claimRows.length
      ? Markup.inlineKeyboard([...claimRows, [Markup.button.callback("Мои задачи", "tasks:mine"), Markup.button.callback("Меню", "menu:view")]])
      : planKeyboard()
  );
}

async function claimPlanStep(ctx: Context, stepId: string) {
  if (!(await requirePrivateChat(ctx, "Выбор шага доступен только в личном чате с ботом."))) return;
  const user = await requireLinkedUser(ctx);
  if (!user?.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plan = await PlanModel.findOne({ category: user.category, ...activePlanFilter, "steps._id": stepId } as any).sort({ createdAt: -1 });
  const step = plan?.steps.id(stepId);
  if (!plan || !step) {
    await ctx.reply("Этот шаг уже недоступен или план был обновлен.", planKeyboard());
    return;
  }

  if (step.assignedTo && step.assignedTo.toString() !== user.id) {
    await ctx.reply("Этот шаг уже назначен другому стажеру. Можно выбрать другой свободный шаг.", Markup.inlineKeyboard([[Markup.button.callback("Свободные шаги", "tasks:available")]]));
    return;
  }

  step.assignedTo = user._id as any;
  if (step.status === "todo") step.status = "in_progress";
  await plan.save();

  await ctx.reply(
    [`Шаг назначен вам: ${step.title}`, `Дедлайн: ${step.deadline}`, `Статус: ${stepStatusLabel(step.status)}`].join("\n"),
    taskKeyboard(step._id.toString(), step.status)
  );
}

async function updateTaskStatus(ctx: Context, stepId: string, status: PlanStepStatus) {
  if (!(await requirePrivateChat(ctx, "Статус личной задачи меняется только в личном чате с ботом."))) return;
  const user = await requireLinkedUser(ctx);
  if (!user?.category) return;
  const plan = await PlanModel.findOne({ category: user.category, ...activePlanFilter, "steps._id": stepId } as any).sort({ createdAt: -1 });
  const step = plan?.steps.id(stepId);
  if (!plan || !step || step.assignedTo?.toString() !== user.id) {
    await ctx.reply("Эта задача не найдена среди назначенных вам шагов.");
    return;
  }
  step.status = status;
  await plan.save();
  await ctx.reply(`Статус обновлен: ${step.title} — ${stepStatusLabel(step.status)}`, taskKeyboard(step._id.toString(), step.status));
}

async function startDailyWizard(ctx: Context) {
  if (!(await requirePrivateChat(ctx, "Дэйлик через Telegram доступен только в личном чате с ботом."))) return;
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  if (user.role === "admin") {
    await ctx.reply("Администратор не отправляет дэйлики.");
    return;
  }

  await TelegramDraftModel.findOneAndUpdate(
    { chatId: String(ctx.chat!.id) },
    {
      chatId: String(ctx.chat!.id),
      userId: user._id,
      flow: "daily",
      step: "yesterday",
      yesterday: "",
      todayPlan: "",
      blockers: "",
      expiresAt: new Date(Date.now() + 1000 * 60 * 30)
    },
    { upsert: true, returnDocument: "after" }
  );
  await ctx.reply("Начинаем дэйлик. Что сделали вчера? Напишите одним сообщением.");
}

async function startBlockerWizard(ctx: Context, stepId?: string) {
  if (!(await requirePrivateChat(ctx, "Блокер по личной задаче лучше отправлять в личном чате с ботом."))) return;
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  await TelegramDraftModel.findOneAndUpdate(
    { chatId: String(ctx.chat!.id) },
    {
      chatId: String(ctx.chat!.id),
      userId: user._id,
      flow: "blocker",
      step: "blocker",
      stepId,
      yesterday: "Сообщил технический блокер по назначенному шагу.",
      todayPlan: "Разобраться с блокером и согласовать следующий шаг с тимлидом.",
      blockers: "",
      expiresAt: new Date(Date.now() + 1000 * 60 * 30)
    },
    { upsert: true, returnDocument: "after" }
  );
  await ctx.reply("Опишите блокер одним сообщением. Я сохраню его как дэйлик с пометкой о проблеме.");
}

async function handleDraftMessage(ctx: Context) {
  if (ctx.chat?.type !== "private") return false;
  const text = getTextFromMessage(ctx);
  if (!text || text.startsWith("/")) return false;

  const draft = await TelegramDraftModel.findOne({ chatId: String(ctx.chat.id), expiresAt: { $gt: new Date() } });
  if (!draft) return false;

  if (draft.flow === "daily") {
    if (draft.step === "yesterday") {
      draft.yesterday = text;
      draft.step = "todayPlan";
      await draft.save();
      await ctx.reply("Принял. Какой план на сегодня?");
      return true;
    }

    if (draft.step === "todayPlan") {
      draft.todayPlan = text;
      draft.step = "blockers";
      await draft.save();
      await ctx.reply("Есть блокеры? Если нет, напишите: нет");
      return true;
    }

    draft.blockers = /^нет$/i.test(text) ? "" : text;
    await draft.save();
    await ctx.reply(
      [`Проверьте дэйлик:`, `Вчера: ${draft.yesterday}`, `Сегодня: ${draft.todayPlan}`, `Блокеры: ${draft.blockers || "нет"}`].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("Отправить", "daily:submit"), Markup.button.callback("Отмена", "daily:cancel")]])
    );
    return true;
  }

  draft.blockers = text;
  await draft.save();
  await ctx.reply(
    [`Проверьте блокер:`, draft.stepId ? `Шаг: ${draft.stepId}` : "", `Блокер: ${draft.blockers}`].filter(Boolean).join("\n"),
    Markup.inlineKeyboard([[Markup.button.callback("Отправить", "daily:submit"), Markup.button.callback("Отмена", "daily:cancel")]])
  );
  return true;
}

async function submitDraft(ctx: Context) {
  if (!(await requirePrivateChat(ctx))) return;
  const draft = await TelegramDraftModel.findOne({ chatId: String(ctx.chat!.id), expiresAt: { $gt: new Date() } });
  if (!draft) {
    await ctx.reply("Черновик не найден или истек. Начните заново.", mainMenuKeyboard());
    return;
  }

  const report = await createDailyReport({
    userId: draft.userId,
    yesterday: draft.yesterday,
    todayPlan: draft.todayPlan,
    blockers: draft.blockers,
    source: "telegram"
  });
  await TelegramDraftModel.deleteOne({ _id: draft._id });
  await ctx.reply(
    [
      "Отчет отправлен и прогнан через AI.",
      `Продуктивность: ${report.aiReview?.productivityScore || 0}%`,
      `Сводка: ${report.aiReview?.summary || "нет сводки"}`
    ].join("\n"),
    mainMenuKeyboard()
  );
}

async function cancelDraft(ctx: Context) {
  if (!(await requirePrivateChat(ctx))) return;
  await TelegramDraftModel.deleteOne({ chatId: String(ctx.chat!.id) });
  await ctx.reply("Черновик отменен.", mainMenuKeyboard());
}

async function sendMainMenu(ctx: Context) {
  if (isGroupChat(ctx)) {
    if (!(await requireGroupAdmin(ctx))) return;
    const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
    await replyTemporary(
      ctx,
      group?.category
        ? `Меню группы департамента: ${categories[group.category as Category]}`
        : "Меню группы. Сначала выберите департамент.",
      group?.category ? groupMenuKeyboard(group.motivationEnabled, group.funEnabled) : groupDepartmentKeyboard(),
      15000
    );
    return;
  }

  const user = await syncPrivateTelegramUser(ctx);
  const registerHint =
    user && !user.emailVerified
      ? "\n\nЯ уже вижу вас в списке Telegram-группы. Завершите регистрацию на сайте/mini app: задайте email, пароль и пройдите мини-опрос."
      : "";
  await ctx.reply(
    [
      "DailyReport ERP бот.",
      "Выберите действие кнопками снизу или через быстрые кнопки под сообщением.",
      "Для привязки используйте: /link email@example.com",
      registerHint
    ].join("\n"),
    tileKeyboard
  );
  await ctx.reply("Быстрое меню:", inlineMenu);
}

async function syncPrivateTelegramUser(ctx: Context) {
  if (ctx.chat?.type !== "private" || !ctx.from) return null;
  const telegramUserId = String(ctx.from.id);
  const username = ctx.from.username?.toLowerCase();
  const user = await UserModel.findOne({
    $or: [{ telegramUserId }, ...(username ? [{ telegramUsername: username }] : [])]
  });
  if (!user) return null;

  user.telegramUserId = user.telegramUserId || telegramUserId;
  if (username) user.telegramUsername = username;
  user.telegramChatId = String(ctx.chat.id);
  user.lastActiveAt = new Date();
  await user.save();
  return user;
}

async function sendLinkHelp(ctx: Context) {
  if (!(await requirePrivateChat(ctx, "Привязка Telegram доступна только в личном чате с ботом."))) return;
  await ctx.reply("Чтобы привязать Telegram к аккаунту, напишите:\n/link email@example.com", inlineMenu);
}

async function sendReportHelp(ctx: Context) {
  if (!(await requirePrivateChat(ctx, "Дэйлик через Telegram доступен только в личном чате с ботом."))) return;
  await ctx.reply(
    [
      "Формат дневного отчета:",
      "/report что сделал вчера | план на сегодня | блокеры",
      "",
      "Пример:",
      "/report собрал страницу отчетов и проверил API | доделать фильтры и отправить PR | нет"
    ].join("\n"),
    Markup.inlineKeyboard([[Markup.button.callback("Посмотреть план", "plan:view"), Markup.button.callback("Меню", "menu:view")]])
  );
}

async function sendPlan(ctx: Context) {
  if (isGroupChat(ctx)) {
    if (!(await requireGroupAdmin(ctx))) return;
    const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
    if (!group?.category) {
      await replyTemporary(ctx, "Группа еще не привязана к департаменту.", groupDepartmentKeyboard(), 15000);
      return;
    }
    const plans = await findActivePlans(group.category as Category, 5);
    await ctx.reply(formatPlansForTelegram(plans));
    return;
  }

  const user = await getLinkedUser(ctx);
  if (!user) {
    await ctx.reply("Сначала привяжите Telegram: /link ваш@email", Markup.inlineKeyboard([[Markup.button.callback("Как привязать", "link:help")]]));
    return;
  }
  if (!user.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plans = await findActivePlans(user.category as Category, 5);
  await ctx.reply(
    formatPlansForTelegram(plans, user.id),
    Markup.inlineKeyboard([[Markup.button.callback("Как написать дэйлик", "report:help"), Markup.button.callback("Обновить", "plan:view")]])
  );
}

async function sendSummary(ctx: Context) {
  if (isGroupChat(ctx)) {
    if (!(await requireGroupAdmin(ctx))) return;
    const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat!.id) });
    if (!group?.category) {
      await replyTemporary(ctx, "Группа еще не привязана к департаменту.", groupDepartmentKeyboard(), 15000);
      return;
    }
    await replyTemporary(ctx, await formatLeadSummary(group.category as Category, "full"), undefined, 20000);
    return;
  }

  const user = await getLinkedUser(ctx);
  if (!user || user.role !== "lead") {
    await ctx.reply("Сводка доступна только привязанному тимлиду.", inlineMenu);
    return;
  }

  await ctx.reply(await formatLeadSummary((user.category || undefined) as Category | undefined, "full"), inlineMenu);
}

async function sendDigestStatus(ctx: Context) {
  if (isGroupChat(ctx)) {
    if (!(await requireGroupAdmin(ctx))) return;
    await replyTemporary(ctx, "Автосводка настраивается в личном чате тимлида с ботом.", undefined, 10000);
    return;
  }

  const user = await getLinkedUser(ctx);
  if (!user || user.role !== "lead") {
    await ctx.reply("Автосводка доступна только привязанному тимлиду.", inlineMenu);
    return;
  }

  await ctx.reply(
    user.telegramDigestEnabled
      ? `Автосводка включена: ${user.telegramDigestTime}, ${digestContentLabel(user.telegramDigestContent)}.`
      : "Автосводка выключена. Можно включить быструю полную сводку на 18:00 или задать вручную: /digest on 18:00 full",
    Markup.inlineKeyboard([
      [Markup.button.callback("Включить 18:00 full", "digest:on:18:00:full")],
      [Markup.button.callback("Отключить", "digest:off"), Markup.button.callback("Меню", "menu:view")]
    ])
  );
}

async function setDigestFromCallback(ctx: Context, enabled: boolean) {
  if (!(await requirePrivateChat(ctx, "Автосводка настраивается только в личном чате тимлида с ботом."))) return;
  const user = await getLinkedUser(ctx);
  if (!user || user.role !== "lead") {
    await ctx.reply("Автосводка доступна только привязанному тимлиду.");
    return;
  }

  user.telegramDigestEnabled = enabled;
  if (enabled) {
    user.telegramDigestTime = "18:00";
    user.telegramDigestContent = "full";
  }
  await user.save();
  await sendDigestStatus(ctx);
}

async function sendLeadDigest(bot: Telegraf, user: Awaited<ReturnType<typeof UserModel.findOne>>) {
  if (!user?.telegramChatId || user.role !== "lead") return;
  const content = (user.telegramDigestContent || "full") as DigestContent;
  const category = (user.category || undefined) as Category | undefined;
  const summary = await formatLeadSummary(category, content);
  await bot.telegram.sendMessage(user.telegramChatId, summary);
}

function startDigestScheduler(bot: Telegraf) {
  if (digestTimer || isServerlessRuntime()) return;

  digestTimer = setInterval(async () => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dayKey = now.toISOString().slice(0, 10);
    const leads = await UserModel.find({
      role: "lead",
      telegramChatId: { $type: "string", $ne: "" },
      telegramDigestEnabled: true,
      telegramDigestTime: currentTime
    });

    for (const lead of leads) {
      const lastSentDay = lead.telegramDigestLastSentAt?.toISOString().slice(0, 10);
      if (lastSentDay === dayKey) continue;
      try {
        await sendLeadDigest(bot, lead);
        lead.telegramDigestLastSentAt = now;
        await lead.save();
      } catch (error) {
        console.error("Telegram digest error", error);
      }
    }
  }, 60_000);
}

function startFunScheduler() {
  if (funTimer || isServerlessRuntime()) return;

  void sendRandomTelegramFunReply().catch((error) => console.error("Telegram initial fun scheduler error", error));
  funTimer = setInterval(() => {
    void sendRandomTelegramFunReply().catch((error) => console.error("Telegram fun scheduler error", error));
  }, 15 * 60_000);
}

export function getTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return undefined;
  if (botInstance) return botInstance;

  const bot = new Telegraf(token);

bot.start(async (ctx) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text.replace(/^\/start(@\w+)?/i, "").trim() : "";
    if (text) {
      const token = text;
      try {
        const user = await UserModel.findOne({ telegramLinkToken: token, telegramLinkTokenExpiresAt: { $gt: new Date() } });
        if (user) {
          const existingTelegramUser = await UserModel.findOne({ telegramUserId: String(ctx.from?.id) });
          if (existingTelegramUser && existingTelegramUser.id !== user.id) {
            if (existingTelegramUser.emailVerified || existingTelegramUser.email) {
              await ctx.reply("Этот Telegram уже привязан к другому подтвержденному аккаунту.");
              return;
            }

            user.telegramActivityMessages = Math.max(user.telegramActivityMessages || 0, existingTelegramUser.telegramActivityMessages || 0);
            user.telegramActivityScore = Math.max(user.telegramActivityScore || 0, existingTelegramUser.telegramActivityScore || 0);
            user.telegramActivitySummary = user.telegramActivitySummary || existingTelegramUser.telegramActivitySummary || "";
            user.telegramGroupChatId = user.telegramGroupChatId || existingTelegramUser.telegramGroupChatId;
            user.telegramLastGroupSeenAt = user.telegramLastGroupSeenAt || existingTelegramUser.telegramLastGroupSeenAt;
            await UserModel.deleteOne({ _id: existingTelegramUser._id });
          }

          user.telegramChatId = String(ctx.chat?.id);
          user.telegramUserId = String(ctx.from?.id);
          if (ctx.from?.username) user.telegramUsername = ctx.from.username.toLowerCase();
          user.telegramLinkToken = undefined as any;
          user.telegramLinkTokenExpiresAt = undefined as any;
          await user.save();
          await ctx.reply(`Telegram привязан к профилю: ${user.name}`, tileKeyboard);
          await ctx.reply("Теперь можно пользоваться меню:", inlineMenu);
          return;
        }
      } catch (error) {
        console.error("Telegram start link error", error);
      }
    }

    return sendMainMenu(ctx);
  });
  bot.command("menu", (ctx) => sendMainMenu(ctx));
  bot.hears(["Меню", "Главное меню"], (ctx) => sendMainMenu(ctx));
  bot.hears("Привязка", (ctx) => sendLinkHelp(ctx));
  bot.hears("План", (ctx) => sendPlan(ctx));
  bot.hears("Дэйлик", (ctx) => sendReportHelp(ctx));
  bot.hears("Мои задачи", (ctx) => sendMyTasks(ctx));
  bot.hears("Свободные шаги", (ctx) => sendAllPlanSteps(ctx));
  bot.hears("Блокер", (ctx) => startBlockerWizard(ctx));
  bot.hears("Сводка", (ctx) => sendSummary(ctx));
  bot.hears("Автосводка", (ctx) => sendDigestStatus(ctx));

  bot.command("group_department", (ctx) => handleGroupDepartmentCommand(ctx));
  bot.command("group_status", (ctx) => sendGroupStatusWithButtons(ctx));
  bot.command("motivation_on", (ctx) => setGroupMotivation(ctx, true));
  bot.command("motivation_off", (ctx) => setGroupMotivation(ctx, false));
  bot.command("motivation", (ctx) => sendGroupMotivationNow(ctx));
  bot.command("day_digest", (ctx) => sendGroupDailyDigestNow(ctx));
  bot.command("fun_add", (ctx) => addGroupFunMedia(ctx));
  bot.command("fun_on", (ctx) => setGroupFun(ctx, true));
  bot.command("fun_off", (ctx) => setGroupFun(ctx, false));
  bot.command("fun_status", (ctx) => sendGroupFunStatus(ctx));
  bot.command("fun_clear", (ctx) => clearGroupFunMedia(ctx));

  bot.on("voice", (ctx) => handleVoiceMessage(ctx));
  bot.on("my_chat_member", (ctx) => handleBotChatMemberUpdate(ctx));

  bot.on("message", async (ctx, next) => {
    if (await handleDraftMessage(ctx)) return;
    await trackNewGroupMembers(ctx);
    const text = getTextFromMessage(ctx);
    await trackGroupText(ctx, text);
    if (await answerGroupQuestion(ctx, text)) return;
    return next();
  });

  bot.action("menu:view", async (ctx) => {
    await ctx.answerCbQuery();
    await sendMainMenu(ctx);
  });
  bot.action("link:help", async (ctx) => {
    await ctx.answerCbQuery();
    await sendLinkHelp(ctx);
  });
  bot.action("report:help", async (ctx) => {
    await ctx.answerCbQuery();
    await sendReportHelp(ctx);
  });
  bot.action("plan:view", async (ctx) => {
    await ctx.answerCbQuery();
    await sendPlan(ctx);
  });
  bot.action("summary:view", async (ctx) => {
    await ctx.answerCbQuery();
    await sendSummary(ctx);
  });
  bot.action("digest:view", async (ctx) => {
    await ctx.answerCbQuery();
    await sendDigestStatus(ctx);
  });
  bot.action("digest:on:18:00:full", async (ctx) => {
    await ctx.answerCbQuery("Автосводка включается");
    await setDigestFromCallback(ctx, true);
  });
  bot.action("digest:off", async (ctx) => {
    await ctx.answerCbQuery("Автосводка отключается");
    await setDigestFromCallback(ctx, false);
  });

  bot.action("group:department:choose", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery();
    await askGroupDepartment(ctx);
  });
  bot.action(/^group:department:(data|system|ml|marketing|sales|erp|security)$/, async (ctx) => {
    const category = parseCategoryAlias(ctx.match[1]);
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery(category ? "Департамент выбран" : "Неизвестный департамент");
    if (category) await applyGroupDepartment(ctx, category);
  });
  bot.action("group:status", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery();
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:motivation:on", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery("Мотивация включается");
    await setGroupMotivation(ctx, true);
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:motivation:off", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery("Мотивация отключается");
    await setGroupMotivation(ctx, false);
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:fun:on", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery("GIF и стикеры включаются");
    await setGroupFun(ctx, true);
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:fun:off", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery("GIF и стикеры отключаются");
    await setGroupFun(ctx, false);
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:motivation:now", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery("Отправляю мотивацию");
    await sendGroupMotivationNow(ctx);
  });
  bot.action("group:digest:now", async (ctx) => {
    if (!(await requireGroupAdmin(ctx))) return;
    await ctx.answerCbQuery("Собираю дайджест");
    await sendGroupDailyDigestNow(ctx);
  });

  bot.action("tasks:mine", async (ctx) => {
    await ctx.answerCbQuery();
    await sendMyTasks(ctx);
  });
  bot.action("tasks:available", async (ctx) => {
    if (isGroupChat(ctx)) {
      await ctx.answerCbQuery("Свободные шаги выбираются в личном чате с ботом.", { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await sendAllPlanSteps(ctx);
  });
  bot.action("plan:steps", async (ctx) => {
    await ctx.answerCbQuery();
    await sendAllPlanSteps(ctx);
  });
  bot.action("daily:start", async (ctx) => {
    await ctx.answerCbQuery();
    await startDailyWizard(ctx);
  });
  bot.action("daily:submit", async (ctx) => {
    await ctx.answerCbQuery("Отправляю");
    await submitDraft(ctx);
  });
  bot.action("daily:cancel", async (ctx) => {
    await ctx.answerCbQuery("Отменено");
    await cancelDraft(ctx);
  });
  bot.action("blocker:start", async (ctx) => {
    await ctx.answerCbQuery();
    await startBlockerWizard(ctx);
  });
  bot.action(/^task:status:([a-f0-9]{24}):(todo|in_progress|done|canceled)$/, async (ctx) => {
    await ctx.answerCbQuery("Обновляю статус");
    await updateTaskStatus(ctx, ctx.match[1], ctx.match[2] as PlanStepStatus);
  });
  bot.action(/^task:claim:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery("Назначаю шаг");
    await claimPlanStep(ctx, ctx.match[1]);
  });
  bot.action(/^task:blocker:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery();
    await startBlockerWizard(ctx, ctx.match[1]);
  });

  bot.command("link", async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await replyTemporary(ctx, "Привязка аккаунта выполняется только в личном чате с ботом. Напишите боту в личку: /link email@example.com", undefined, 12000);
      return;
    }

    const email = ctx.message.text.replace(/^\/link(@\w+)?/i, "").trim().toLowerCase();
    if (!email) {
      await sendLinkHelp(ctx);
      return;
    }

    try {
      const user = await UserModel.findOne({ email });
      if (!user || !user.emailVerified) {
        await ctx.reply("Пользователь не найден или email еще не подтвержден на сайте.", inlineMenu);
        return;
      }

      const existingTelegramUser = await UserModel.findOne({ telegramUserId: String(ctx.from.id) });
      if (existingTelegramUser && existingTelegramUser.id !== user.id) {
        if (existingTelegramUser.emailVerified || existingTelegramUser.email) {
          await ctx.reply("Этот Telegram уже привязан к другому подтвержденному аккаунту.");
          return;
        }

        user.telegramActivityMessages = Math.max(user.telegramActivityMessages || 0, existingTelegramUser.telegramActivityMessages || 0);
        user.telegramActivityScore = Math.max(user.telegramActivityScore || 0, existingTelegramUser.telegramActivityScore || 0);
        user.telegramActivitySummary = user.telegramActivitySummary || existingTelegramUser.telegramActivitySummary || "";
        user.telegramGroupChatId = user.telegramGroupChatId || existingTelegramUser.telegramGroupChatId;
        user.telegramLastGroupSeenAt = user.telegramLastGroupSeenAt || existingTelegramUser.telegramLastGroupSeenAt;
        await UserModel.deleteOne({ _id: existingTelegramUser._id });
      }

      user.telegramChatId = String(ctx.chat.id);
      user.telegramUserId = String(ctx.from.id);
      if (ctx.from.username) user.telegramUsername = ctx.from.username.toLowerCase();
      await user.save();
      await ctx.reply(`Telegram привязан к профилю: ${user.name}`, tileKeyboard);
      await ctx.reply("Теперь можно пользоваться меню:", inlineMenu);
    } catch (error) {
      console.error("Telegram /link error", error);
      await ctx.reply("Не удалось привязать Telegram. Проверьте настройки MongoDB на сервере.");
    }
  });

  bot.command("report", async (ctx) => {
    if (!(await requirePrivateChat(ctx, "Дэйлик через Telegram доступен только в личном чате с ботом."))) return;
    try {
      const user = await getLinkedUser(ctx);
      if (!user) {
        await ctx.reply("Сначала привяжите Telegram: /link ваш@email", Markup.inlineKeyboard([[Markup.button.callback("Как привязать", "link:help")]]));
        return;
      }
      if (user.role === "admin") {
        await ctx.reply("Администратор не отправляет дэйлики.");
        return;
      }

      const parsed = parseReport(ctx.message.text);
      if (!parsed || parsed.yesterday.length < 10 || parsed.todayPlan.length < 10) {
        await sendReportHelp(ctx);
        return;
      }

      const report = await createDailyReport({ userId: user._id, ...parsed, source: "telegram" });
      await ctx.reply(
        [
          "Отчет принят и прогнан через AI.",
          `Продуктивность: ${report.aiReview?.productivityScore || 0}%`,
          `Сводка: ${report.aiReview?.summary || "нет сводки"}`,
          `Уверенность AI: ${report.aiReview?.confidence || "medium"}`,
          user.role === "intern" && report.aiReview?.deadlineImpactDays
            ? `Влияние на дедлайн: +${report.aiReview.deadlineImpactDays} дн.`
            : "Дедлайн без изменений."
        ].join("\n"),
        inlineMenu
      );
    } catch (error) {
      console.error("Telegram /report error", error);
      await ctx.reply(error instanceof Error ? error.message : "Не удалось сохранить отчет.");
    }
  });

  bot.command("plan", (ctx) => sendPlan(ctx));
  bot.command("steps", (ctx) => sendAllPlanSteps(ctx));
  bot.command("summary", (ctx) => sendSummary(ctx));

  bot.command("digest", async (ctx) => {
    if (isGroupChat(ctx)) {
      if (!(await requireGroupAdmin(ctx))) return;
      await replyTemporary(ctx, "Автосводка настраивается в личном чате тимлида с ботом.", undefined, 10000);
      return;
    }

    try {
      const user = await getLinkedUser(ctx);
      if (!user || user.role !== "lead") {
        await ctx.reply("Автосводка доступна только привязанному тимлиду.", inlineMenu);
        return;
      }

      const parsed = parseDigest(ctx.message.text);
      if (!parsed.action || parsed.action === "status") {
        await sendDigestStatus(ctx);
        return;
      }

      if (parsed.action === "off") {
        user.telegramDigestEnabled = false;
        await user.save();
        await sendDigestStatus(ctx);
        return;
      }

      const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.time || "");
      const validContent = ["productivity", "reports", "full"].includes(parsed.content);
      if (parsed.action !== "on" || !validTime || !validContent) {
        await ctx.reply("Формат: /digest on 18:00 productivity|reports|full или /digest off");
        return;
      }

      user.telegramDigestEnabled = true;
      user.telegramDigestTime = parsed.time;
      user.telegramDigestContent = parsed.content;
      await user.save();
      await sendDigestStatus(ctx);
    } catch (error) {
      console.error("Telegram /digest error", error);
      await ctx.reply("Не удалось изменить настройки автосводки. Проверьте MongoDB на сервере.");
    }
  });

  bot.catch((error, ctx) => {
    console.error("Telegram bot error", error);
    void ctx.reply("Команда не обработалась из-за ошибки на сервере. Подробности будут в логах Vercel.").catch(() => undefined);
  });

  void bot.telegram.setMyCommands([
    { command: "menu", description: "Открыть меню" },
    { command: "plan", description: "План департамента" },
    { command: "steps", description: "Свободные шаги" },
    { command: "report", description: "Отправить дэйлик" },
    { command: "summary", description: "Сводка для тимлида" },
    { command: "day_digest", description: "Дайджест группы" },
    { command: "motivation", description: "Мотивация группы" },
    { command: "fun_add", description: "Сохранить GIF или стикер" },
    { command: "fun_status", description: "Настройки GIF и стикеров" },
    { command: "digest", description: "Автосводка для тимлида" },
    { command: "link", description: "Привязать Telegram к аккаунту" }
  ]);

  void bot.telegram
    .setChatMenuButton({
      menuButton: {
        type: "web_app",
        text: "DailyReport ERP",
        web_app: { url: appUrl }
      }
    })
    .catch(() => undefined);

  botInstance = bot;
  startDigestScheduler(bot);
  startFunScheduler();
  return bot;
}

export async function handleTelegramWebhook(update: unknown) {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");
  await bot.handleUpdate(update as never);
}

export function startTelegramBot() {
  const bot = getTelegramBot();
  if (!bot) {
    console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN is not set.");
    return;
  }

  if (process.env.TELEGRAM_BOT_MODE === "webhook") {
    console.log("Telegram bot webhook mode enabled.");
    return;
  }

  if (pollingStarted) return;
  pollingStarted = true;

  bot
    .launch()
    .then(() => console.log("Telegram bot started in polling mode."))
    .catch((err) => {
      pollingStarted = false;
      const errorCode = (err as { response?: { error_code?: number } })?.response?.error_code;
      if (errorCode === 409) {
        console.warn("Telegram bot polling skipped: another bot instance is already running getUpdates. Stop the other backend process or use TELEGRAM_BOT_MODE=webhook.");
        return;
      }
      console.error("Telegram bot launch error:", err);
    });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
