import { Markup, Telegraf, type Context } from "telegraf";
import { hashPassword } from "./auth.js";
import { askGroqAssistant } from "./ai.js";
import { categories, randomAvatarColor } from "./constants.js";
import { PlanModel, TelegramActivityModel, TelegramDraftModel, TelegramGroupModel, UserModel } from "./models.js";
import { createDailyReport, formatLeadSummary } from "./services.js";
import type { Category } from "./types.js";

type DigestContent = "productivity" | "reports" | "full";

let botInstance: Telegraf | undefined;
let digestTimer: NodeJS.Timeout | undefined;

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

const appUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://daily-report-b.vercel.app";

const departmentKeywords: Record<Category, string[]> = {
  "data-system-ml": ["data", "данн", "аналит", "system", "систем", "ml", "machine", "машин"],
  "marketing-sales": ["marketing", "маркет", "sales", "продаж"],
  "erp-development": ["erp", "разработ", "dev", "frontend", "backend"],
  "data-security": ["security", "безопас", "защит", "данных"]
};

const categoryAliases: Record<string, Category> = {
  data: "data-system-ml",
  analytics: "data-system-ml",
  ml: "data-system-ml",
  marketing: "marketing-sales",
  sales: "marketing-sales",
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

function digestContentLabel(content?: string) {
  if (content === "productivity") return "продуктивность дня";
  if (content === "reports") return "посещаемость и отчеты";
  return "полная сводка";
}

function formatPlanForTelegram(plan: Awaited<ReturnType<typeof PlanModel.findOne>>, chatUserId?: string) {
  if (!plan) return "План для вашего департамента еще не создан тимлидом.";
  const steps = (plan.steps || [])
    .slice(0, 10)
    .map((step, index) => {
      const assigned = step.assignedTo?.toString() === chatUserId ? " | назначено вам" : step.assignedTo ? " | назначено" : "";
      const status = step.status === "done" ? "готово" : step.status === "in_progress" ? "в работе" : "ожидает";
      return `${index + 1}. ${step.title} - до ${step.deadline} | ${status}${assigned}`;
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
    [Markup.button.callback("ERP", "group:department:erp"), Markup.button.callback("Data / ML", "group:department:data")],
    [Markup.button.callback("Marketing / Sales", "group:department:marketing"), Markup.button.callback("Security", "group:department:security")]
  ]);
}

function groupActionsKeyboard(enabled?: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Статус группы", "group:status"), Markup.button.callback("Сменить департамент", "group:department:choose")],
    [
      enabled
        ? Markup.button.callback("Отключить мотивацию", "group:motivation:off")
        : Markup.button.callback("Включить мотивацию", "group:motivation:on")
    ]
  ]);
}

async function askGroupDepartment(ctx: Context) {
  await ctx.reply("Выберите департамент для этой группы:", groupDepartmentKeyboard());
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
    [Markup.button.callback("Мои задачи", "tasks:mine"), Markup.button.callback("Все шаги", "plan:steps")],
    [Markup.button.callback("Написать дэйлик", "daily:start"), Markup.button.callback("Сообщить блокер", "blocker:start")],
    [Markup.button.webApp("Открыть приложение", appUrl)]
  ]);
}

function taskKeyboard(stepId: string, status: string) {
  const statusRow =
    status === "done"
      ? [Markup.button.callback("Вернуть в работу", `task:status:${stepId}:in_progress`)]
      : [
          Markup.button.callback("В работу", `task:status:${stepId}:in_progress`),
          Markup.button.callback("Готово", `task:status:${stepId}:done`)
        ];
  return Markup.inlineKeyboard([statusRow, [Markup.button.callback("Есть блокер", `task:blocker:${stepId}`)]]);
}

function categoryHelp() {
  return [
    "Департаменты:",
    "/group_department data",
    "/group_department marketing",
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

async function trackGroupMessage(ctx: Context) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return;
  if (!ctx.from || ctx.from.is_bot) return;

  const text = getTextFromMessage(ctx);
  if (!text || text.startsWith("/")) return;

  const title = "title" in ctx.chat ? ctx.chat.title : "";
  const category = detectCategoryFromGroupTitle(title);
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
      lastActivityAt: now
    },
    { upsert: true, new: true }
  );

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
    user.telegramGroupChatId = chatId;
    user.category = user.category || category;
  }

  await TelegramActivityModel.create({
    userId: user._id,
    chatId,
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

async function applyGroupDepartment(ctx: Context, category: Category) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Эта команда работает только в группе департамента.");
    return;
  }

  const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId: String(ctx.chat.id) },
    {
      chatId: String(ctx.chat.id),
      title,
      category,
      lastActivityAt: new Date()
    },
    { upsert: true, new: true }
  );

  await ctx.reply(`Группа привязана к департаменту: ${categories[category]}. Участников вижу: ${group.membersSeen}.`, groupActionsKeyboard(group.motivationEnabled));
}

async function setGroupDepartment(ctx: Context) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Эта команда работает только в группе департамента.");
    return;
  }

  const text = getTextFromMessage(ctx);
  const category = parseCategoryAlias(text.split(/\s+/)[1]);
  if (!category) {
    await ctx.reply(categoryHelp());
    return;
  }

  const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
  const group = await TelegramGroupModel.findOneAndUpdate(
    { chatId: String(ctx.chat.id) },
    {
      chatId: String(ctx.chat.id),
      title,
      category,
      lastActivityAt: new Date()
    },
    { upsert: true, new: true }
  );

  await ctx.reply(`Группа привязана к департаменту: ${categories[category]}. Участников вижу: ${group.membersSeen}.`);
}

async function sendGroupStatus(ctx: Context) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Эта команда работает только в группе департамента.");
    return;
  }

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  if (!group?.category) {
    await ctx.reply(`Группа еще не привязана к департаменту.\n${categoryHelp()}`);
    return;
  }

  const members = await UserModel.countDocuments({ telegramGroupChatId: String(ctx.chat.id), role: "intern" });
  const plan = await PlanModel.findOne({ category: group.category });
  await ctx.reply(
    [
      `Департамент: ${categories[group.category as Category]}`,
      `Стажеров найдено по чату: ${members}`,
      `Мотивация: ${group.motivationEnabled ? "включена" : "выключена"}`,
      plan ? `План: ${plan.title}, дедлайн ${plan.adjustedDeadline}` : "План департамента еще не создан"
    ].join("\n")
  );
}

async function setGroupMotivation(ctx: Context, enabled: boolean) {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Эта команда работает только в группе департамента.");
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
      motivationEnabled: enabled
    },
    { upsert: true, new: true }
  );

  await ctx.reply(`Будничная мотивация ${group.motivationEnabled ? "включена" : "выключена"}.`);
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
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Эта команда работает только в группе департамента.");
    return;
  }

  const group = await TelegramGroupModel.findOne({ chatId: String(ctx.chat.id) });
  if (!group?.category) {
    await ctx.reply("Группа еще не привязана к департаменту.", groupDepartmentKeyboard());
    return;
  }

  const members = await UserModel.countDocuments({ telegramGroupChatId: String(ctx.chat.id), role: "intern" });
  const plan = await PlanModel.findOne({ category: group.category });
  await ctx.reply(
    [
      `Департамент: ${categories[group.category as Category]}`,
      `Стажеров найдено по чату: ${members}`,
      `Мотивация: ${group.motivationEnabled ? "включена" : "выключена"}`,
      plan ? `План: ${plan.title}, дедлайн ${plan.adjustedDeadline}` : "План департамента еще не создан"
    ].join("\n"),
    groupActionsKeyboard(group.motivationEnabled)
  );
}

async function buildMotivationMessage(category: Category) {
  const [plan, interns] = await Promise.all([
    PlanModel.findOne({ category }),
    UserModel.find({ role: "intern", category }).sort({ telegramActivityScore: -1 }).limit(5)
  ]);
  const openSteps = (plan?.steps || []).filter((step) => step.status !== "done").slice(0, 4);
  const activeNames = interns.filter((user) => (user.telegramActivityMessages || 0) > 0).map((user) => user.name).slice(0, 4);

  const fallback = [
    `Доброе утро, ${categories[category]}.`,
    plan ? `Фокус по плану "${plan.title}": ${openSteps.map((step) => step.title).join("; ") || "держим текущий темп"}.` : "Сегодня держим фокус на задачах департамента.",
    activeNames.length ? `Отдельно вижу активность: ${activeNames.join(", ")}. Хороший ритм.` : "Пишите вопросы и блокеры в чат, так тимлид быстрее поможет.",
    "Коротко зафиксируйте прогресс в дэйлике и не тяните с блокерами."
  ].join("\n");

  const ai = await askGroqAssistant(`
Сгенерируй короткое мотивирующее сообщение в Telegram-группу стажеров.
Тон: дружелюбно, без пафоса, 3-5 предложений.
Департамент: ${categories[category]}
План: ${plan?.title || "план еще не создан"}
Дедлайн: ${plan?.adjustedDeadline || "не задан"}
Открытые шаги: ${openSteps.map((step) => `${step.title} до ${step.deadline}`).join("; ") || "нет данных"}
Активные стажеры: ${activeNames.join(", ") || "нет данных"}
`);
  return ai || fallback;
}

export async function sendWeekdayGroupMotivation() {
  const bot = getTelegramBot();
  if (!bot) throw new Error("Telegram bot is not configured");

  const now = new Date();
  const weekday = now.getUTCDay();
  if (weekday === 0 || weekday === 6) return { sent: 0, skipped: "weekend" };

  const dayKey = now.toISOString().slice(0, 10);
  const groups = await TelegramGroupModel.find({
    category: { $exists: true },
    motivationEnabled: true
  });

  let sent = 0;
  for (const group of groups) {
    const lastSentDay = group.motivationLastSentAt?.toISOString().slice(0, 10);
    if (lastSentDay === dayKey) continue;

    const message = await buildMotivationMessage(group.category as Category);
    await bot.telegram.sendMessage(group.chatId, message);
    group.motivationLastSentAt = now;
    await group.save();
    sent += 1;
  }

  return { sent };
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

async function sendMyTasks(ctx: Context) {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  if (!user.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plan = await PlanModel.findOne({ category: user.category });
  if (!plan) {
    await ctx.reply("План департамента еще не создан.", mainMenuKeyboard(user.role));
    return;
  }

  const assignedSteps = (plan.steps || []).filter((step) => step.assignedTo?.toString() === user.id);
  if (!assignedSteps.length) {
    await ctx.reply("Пока нет назначенных лично вам шагов. Можно посмотреть общий план.", Markup.inlineKeyboard([[Markup.button.callback("Все шаги", "plan:steps"), Markup.button.callback("Меню", "menu:view")]]));
    return;
  }

  await ctx.reply(`Ваши задачи по плану "${plan.title}":`);
  for (const step of assignedSteps.slice(0, 8)) {
    const status = step.status === "done" ? "готово" : step.status === "in_progress" ? "в работе" : "ожидает";
    await ctx.reply(
      [`${step.title}`, step.description ? `Описание: ${step.description}` : "", `Дедлайн: ${step.deadline}`, `Статус: ${status}`].filter(Boolean).join("\n"),
      taskKeyboard(step._id.toString(), step.status)
    );
  }
}

async function sendAllPlanSteps(ctx: Context) {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  if (!user.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plan = await PlanModel.findOne({ category: user.category });
  if (!plan) {
    await ctx.reply("План департамента еще не создан.", mainMenuKeyboard(user.role));
    return;
  }

  const lines = (plan.steps || []).slice(0, 12).map((step, index) => {
    const status = step.status === "done" ? "готово" : step.status === "in_progress" ? "в работе" : "ожидает";
    const mine = step.assignedTo?.toString() === user.id ? " | ваше" : "";
    return `${index + 1}. ${step.title} - до ${step.deadline} | ${status}${mine}`;
  });
  await ctx.reply(lines.length ? lines.join("\n") : "В плане пока нет шагов.", planKeyboard());
}

async function updateTaskStatus(ctx: Context, stepId: string, status: "todo" | "in_progress" | "done") {
  const user = await requireLinkedUser(ctx);
  if (!user?.category) return;
  const plan = await PlanModel.findOne({ category: user.category });
  const step = plan?.steps.id(stepId);
  if (!plan || !step || step.assignedTo?.toString() !== user.id) {
    await ctx.reply("Эта задача не найдена среди назначенных вам шагов.");
    return;
  }
  step.status = status;
  await plan.save();
  await ctx.reply(`Статус обновлен: ${step.title}`, taskKeyboard(step._id.toString(), step.status));
}

async function startDailyWizard(ctx: Context) {
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
    { upsert: true, new: true }
  );
  await ctx.reply("Начинаем дэйлик. Что сделали вчера? Напишите одним сообщением.");
}

async function startBlockerWizard(ctx: Context, stepId?: string) {
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
    { upsert: true, new: true }
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
  await TelegramDraftModel.deleteOne({ chatId: String(ctx.chat!.id) });
  await ctx.reply("Черновик отменен.", mainMenuKeyboard());
}

async function sendMainMenu(ctx: Context) {
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
  await ctx.reply("Чтобы привязать Telegram к аккаунту, напишите:\n/link email@example.com", inlineMenu);
}

async function sendReportHelp(ctx: Context) {
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
  const user = await getLinkedUser(ctx);
  if (!user) {
    await ctx.reply("Сначала привяжите Telegram: /link ваш@email", Markup.inlineKeyboard([[Markup.button.callback("Как привязать", "link:help")]]));
    return;
  }
  if (!user.category) {
    await ctx.reply("Сначала выберите департамент на сайте.");
    return;
  }

  const plan = await PlanModel.findOne({ category: user.category });
  await ctx.reply(
    formatPlanForTelegram(plan, user.id),
    Markup.inlineKeyboard([[Markup.button.callback("Как написать дэйлик", "report:help"), Markup.button.callback("Обновить", "plan:view")]])
  );
}

async function sendSummary(ctx: Context) {
  const user = await getLinkedUser(ctx);
  if (!user || user.role !== "lead") {
    await ctx.reply("Сводка доступна только привязанному тимлиду.", inlineMenu);
    return;
  }

  await ctx.reply(await formatLeadSummary((user.category || undefined) as Category | undefined, "full"), inlineMenu);
}

async function sendDigestStatus(ctx: Context) {
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
      telegramChatId: { $exists: true },
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

export function getTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return undefined;
  if (botInstance) return botInstance;

  const bot = new Telegraf(token);

  bot.start((ctx) => sendMainMenu(ctx));
  bot.command("menu", (ctx) => sendMainMenu(ctx));
  bot.hears(["Меню", "Главное меню"], (ctx) => sendMainMenu(ctx));
  bot.hears("Привязка", (ctx) => sendLinkHelp(ctx));
  bot.hears("План", (ctx) => sendPlan(ctx));
  bot.hears("Дэйлик", (ctx) => sendReportHelp(ctx));
  bot.hears("Мои задачи", (ctx) => sendMyTasks(ctx));
  bot.hears("Блокер", (ctx) => startBlockerWizard(ctx));
  bot.hears("Сводка", (ctx) => sendSummary(ctx));
  bot.hears("Автосводка", (ctx) => sendDigestStatus(ctx));

  bot.command("group_department", (ctx) => handleGroupDepartmentCommand(ctx));
  bot.command("group_status", (ctx) => sendGroupStatusWithButtons(ctx));
  bot.command("motivation_on", (ctx) => setGroupMotivation(ctx, true));
  bot.command("motivation_off", (ctx) => setGroupMotivation(ctx, false));

  bot.on("message", async (ctx, next) => {
    if (await handleDraftMessage(ctx)) return;
    await trackGroupMessage(ctx);
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
    await ctx.answerCbQuery();
    await askGroupDepartment(ctx);
  });
  bot.action(/^group:department:(data|marketing|erp|security)$/, async (ctx) => {
    const category = parseCategoryAlias(ctx.match[1]);
    await ctx.answerCbQuery(category ? "Департамент выбран" : "Неизвестный департамент");
    if (category) await applyGroupDepartment(ctx, category);
  });
  bot.action("group:status", async (ctx) => {
    await ctx.answerCbQuery();
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:motivation:on", async (ctx) => {
    await ctx.answerCbQuery("Мотивация включается");
    await setGroupMotivation(ctx, true);
    await sendGroupStatusWithButtons(ctx);
  });
  bot.action("group:motivation:off", async (ctx) => {
    await ctx.answerCbQuery("Мотивация отключается");
    await setGroupMotivation(ctx, false);
    await sendGroupStatusWithButtons(ctx);
  });

  bot.action("tasks:mine", async (ctx) => {
    await ctx.answerCbQuery();
    await sendMyTasks(ctx);
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
  bot.action(/^task:status:([a-f0-9]{24}):(todo|in_progress|done)$/, async (ctx) => {
    await ctx.answerCbQuery("Обновляю статус");
    await updateTaskStatus(ctx, ctx.match[1], ctx.match[2] as "todo" | "in_progress" | "done");
  });
  bot.action(/^task:blocker:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery();
    await startBlockerWizard(ctx, ctx.match[1]);
  });

  bot.command("link", async (ctx) => {
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
  bot.command("summary", (ctx) => sendSummary(ctx));

  bot.command("digest", async (ctx) => {
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
    { command: "report", description: "Отправить дэйлик" },
    { command: "summary", description: "Сводка для тимлида" },
    { command: "digest", description: "Автосводка для тимлида" },
    { command: "link", description: "Привязать Telegram к аккаунту" }
  ]);

  botInstance = bot;
  startDigestScheduler(bot);
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

  bot.launch();
  console.log("Telegram bot started in polling mode.");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
