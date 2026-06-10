import type { Context } from "telegraf";
import { addIsoDays, businessDateIso, businessDateTime, businessWeekday } from "../date.js";
import { PlanModel } from "../models.js";
import type { Category } from "../types.js";
import { categoryAliases, departmentKeywords, type DigestContent, type TelegramPlanDocument } from "./config.js";

// Чистые помощники Telegram-слоя: парсинг, форматирование, эвристики над данными.
// Здесь нет состояния бота и сетевых вызовов — только преобразования.

export function todayIso() {
  return businessDateIso();
}

export function isBusinessWeekday(date = new Date()) {
  const weekday = businessWeekday(date);
  return weekday !== 0 && weekday !== 6;
}

export function randomItem<T>(items: readonly T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

export function nextRandomFunReplyAt(now = new Date()) {
  const minimumLeadMs = 30 * 60 * 1000;
  const localToday = businessDateIso(now);

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const localDay = addIsoDays(localToday, dayOffset);
    const weekday = new Date(`${localDay}T00:00:00.000Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    const randomMinute = 10 * 60 + Math.floor(Math.random() * 8 * 60);
    const hour = Math.floor(randomMinute / 60);
    const minute = randomMinute % 60;
    const candidate = businessDateTime(localDay, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    if (candidate.getTime() > now.getTime() + minimumLeadMs) return candidate;
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

export function parseReport(text: string) {
  const lines = text
    .replace(/^\/report(@\w+)?/i, "")
    .trim()
    .split("|")
    .map((part) => part.trim());

  if (lines.length < 2) return null;
  const blockers = lines[2] || "";
  return {
    yesterday: lines[0],
    todayPlan: lines[1],
    blockers: /^(нет|нету|-|no|none)\.?$/i.test(blockers) ? "" : blockers
  };
}

export function parseDigest(text: string) {
  const [, action, time, content] = text.trim().split(/\s+/);
  return {
    action,
    time,
    content: (content || "full") as DigestContent
  };
}

export function digestContentLabel(content?: string) {
  if (content === "productivity") return "продуктивность дня";
  if (content === "reports") return "посещаемость и отчеты";
  return "полная сводка";
}

export function stepStatusLabel(status: string) {
  if (status === "done") return "готово";
  if (status === "in_progress") return "в работе";
  if (status === "canceled") return "отменено";
  return "ожидает";
}

export function formatShortDate(value: string) {
  const [year, month, day] = value.split("-");
  const monthLabels = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const monthIndex = Number(month) - 1;
  if (!year || !day || monthIndex < 0 || monthIndex >= monthLabels.length) return value;
  return `${Number(day)} ${monthLabels[monthIndex]} ${year}`;
}

export function formatPlanForTelegram(plan: Awaited<ReturnType<typeof PlanModel.findOne>>, chatUserId?: string) {
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

export function formatPlansForTelegram(plans: TelegramPlanDocument[], chatUserId?: string) {
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

export function detectCategoryFromGroupTitle(title: string): Category | undefined {
  const normalized = title.toLowerCase();
  const match = Object.entries(departmentKeywords).find(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)));
  return match?.[0] as Category | undefined;
}

export function parseCategoryAlias(value?: string) {
  if (!value) return undefined;
  return categoryAliases[value.trim().toLowerCase()];
}

export function buildTelegramName(from: NonNullable<Context["from"]>) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || `Telegram ${from.id}`;
}

export function buildTelegramMemberName(member: { id: number; first_name: string; last_name?: string; username?: string }) {
  return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.username || `Telegram ${member.id}`;
}

export function localActivitySummary(messages: string[]) {
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

export function looksLikeTaskQuestion(text: string) {
  return /(мо(и|я)|мне|назнач|задач|шаг|делать|работать)/i.test(text) && /(шаг|задач|назнач|план)/i.test(text);
}

export function looksLikePlanQuestion(text: string) {
  return /(план|дедлайн|этап|проект|изменени)/i.test(text);
}
