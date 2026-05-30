import { Telegraf } from "telegraf";
import { UserModel } from "./models.js";
import { createDailyReport, formatLeadSummary } from "./services.js";
import type { Category } from "./types.js";

type DigestContent = "productivity" | "reports" | "full";

let botInstance: Telegraf | undefined;
let digestTimer: NodeJS.Timeout | undefined;

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

async function sendLeadDigest(bot: Telegraf, user: Awaited<ReturnType<typeof UserModel.findOne>>) {
  if (!user?.telegramChatId || user.role !== "lead") return;
  const summary = await formatLeadSummary((user.category || undefined) as Category | undefined, (user.telegramDigestContent || "full") as DigestContent);
  await bot.telegram.sendMessage(user.telegramChatId, summary);
}

function startDigestScheduler(bot: Telegraf) {
  if (digestTimer) return;

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

  bot.start((ctx) => {
    ctx.reply(
      [
        "DailyReport ERP бот.",
        "Привязка: /link email@example.com",
        "Дэйлик: /report что сделал вчера | план на сегодня | блокеры",
        "Сводка для тимлида: /summary",
        "Автосводка: /digest on 18:00 full",
        "Отключить автосводку: /digest off"
      ].join("\n")
    );
  });

  bot.command("link", async (ctx) => {
    const email = ctx.message.text.replace(/^\/link(@\w+)?/i, "").trim().toLowerCase();
    if (!email) {
      await ctx.reply("Укажите email: /link arman@erp.local");
      return;
    }

    const user = await UserModel.findOne({ email });
    if (!user || !user.emailVerified) {
      await ctx.reply("Пользователь не найден или email еще не подтвержден на сайте.");
      return;
    }

    user.telegramChatId = String(ctx.chat.id);
    await user.save();
    await ctx.reply(`Telegram привязан к профилю: ${user.name}`);
  });

  bot.command("report", async (ctx) => {
    const user = await UserModel.findOne({ telegramChatId: String(ctx.chat.id) });
    if (!user) {
      await ctx.reply("Сначала привяжите Telegram: /link ваш@email");
      return;
    }
    if (user.role === "admin") {
      await ctx.reply("Администратор не отправляет дэйлики.");
      return;
    }

    const parsed = parseReport(ctx.message.text);
    if (!parsed || parsed.yesterday.length < 10 || parsed.todayPlan.length < 10) {
      await ctx.reply("Формат: /report что сделал вчера | план на сегодня | блокеры");
      return;
    }

    try {
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
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Не удалось сохранить отчет.");
    }
  });

  bot.command("summary", async (ctx) => {
    const user = await UserModel.findOne({ telegramChatId: String(ctx.chat.id) });
    if (!user || user.role !== "lead") {
      await ctx.reply("Сводка доступна только привязанному тимлиду.");
      return;
    }

    await ctx.reply(await formatLeadSummary((user.category || undefined) as Category | undefined, "full"));
  });

  bot.command("digest", async (ctx) => {
    const user = await UserModel.findOne({ telegramChatId: String(ctx.chat.id) });
    if (!user || user.role !== "lead") {
      await ctx.reply("Автосводка доступна только привязанному тимлиду.");
      return;
    }

    const parsed = parseDigest(ctx.message.text);
    if (!parsed.action || parsed.action === "status") {
      await ctx.reply(
        user.telegramDigestEnabled
          ? `Автосводка включена: ${user.telegramDigestTime}, ${digestContentLabel(user.telegramDigestContent)}.`
          : "Автосводка выключена. Пример: /digest on 18:00 full"
      );
      return;
    }

    if (parsed.action === "off") {
      user.telegramDigestEnabled = false;
      await user.save();
      await ctx.reply("Автосводка выключена.");
      return;
    }

    if (parsed.action !== "on" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.time) || !["productivity", "reports", "full"].includes(parsed.content)) {
      await ctx.reply("Формат: /digest on 18:00 productivity|reports|full или /digest off");
      return;
    }

    user.telegramDigestEnabled = true;
    user.telegramDigestTime = parsed.time;
    user.telegramDigestContent = parsed.content;
    await user.save();
    await ctx.reply(`Автосводка включена: ${parsed.time}, ${digestContentLabel(parsed.content)}.`);
  });

  bot.catch((error) => {
    console.error("Telegram bot error", error);
  });

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
