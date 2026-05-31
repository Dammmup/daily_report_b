import { Markup, Telegraf, type Context } from "telegraf";
import { PlanModel, UserModel } from "./models.js";
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

async function getLinkedUser(ctx: Context) {
  if (!ctx.chat?.id) return null;
  return UserModel.findOne({ telegramChatId: String(ctx.chat.id) });
}

async function sendMainMenu(ctx: Context) {
  await ctx.reply(
    [
      "DailyReport ERP бот.",
      "Выберите действие кнопками снизу или через быстрые кнопки под сообщением.",
      "Для привязки используйте: /link email@example.com"
    ].join("\n"),
    tileKeyboard
  );
  await ctx.reply("Быстрое меню:", inlineMenu);
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
  bot.hears("Сводка", (ctx) => sendSummary(ctx));
  bot.hears("Автосводка", (ctx) => sendDigestStatus(ctx));

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
