import { Markup } from "telegraf";
import { PlanModel } from "../models.js";
import type { Category } from "../types.js";

// Типы, общие для Telegram-слоя.
export type DigestContent = "productivity" | "reports" | "full";
export type TelegramFunMedia = {
  type: "animation" | "sticker";
  fileId: string;
  fileUniqueId?: string;
};
export type PlanStepStatus = "todo" | "in_progress" | "done" | "canceled";
export type TelegramPlanDocument = NonNullable<Awaited<ReturnType<typeof PlanModel.findOne>>>;

// Тайминги и окна.
export const temporaryGroupMessageTtlMs = Number(process.env.TELEGRAM_TEMP_MESSAGE_TTL_MS || 5000);
export const activePlanFilter = { status: { $in: ["draft", "approved"] as const } } as any;
export const funReplyLookbackMs = 72 * 60 * 60 * 1000;
export const telegramAiWindowMs = 10 * 60 * 1000;
export const telegramAiCooldownMs = 20 * 60 * 1000;

export const appUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://daily-report-f.vercel.app";

// Статические клавиатуры/меню.
export const tileKeyboard = Markup.keyboard([
  ["План", "Дэйлик"],
  ["Сводка", "Автосводка"],
  ["Привязка", "Меню"]
]).resize();

export const inlineMenu = Markup.inlineKeyboard([
  [Markup.button.callback("План департамента", "plan:view"), Markup.button.callback("Дэйлик", "report:help")],
  [Markup.button.callback("Сводка", "summary:view"), Markup.button.callback("Автосводка", "digest:view")],
  [Markup.button.callback("Привязка Telegram", "link:help")]
]);

// Карты для определения департамента по тексту/алиасу.
export const departmentKeywords: Record<Category, string[]> = {
  "data-analytics": ["data", "данн", "аналит", "дашборд", "метрик", "bi"],
  "system-analytics": ["system", "систем", "требован", "bpmn", "uml", "аналит"],
  "machine-learning": ["ml", "machine", "машин", "модель", "нейро", "ai"],
  "marketing": ["marketing", "маркет", "контент", "smm", "instagram"],
  "sales": ["sales", "продаж", "лид", "ворон"],
  "erp-development": ["erp", "разработ", "dev", "frontend", "backend"],
  "data-security": ["security", "безопас", "защит", "данных"]
};

export const categoryAliases: Record<string, Category> = {
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
