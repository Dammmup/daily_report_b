import type { Category } from "./types.js";

export const categories: Record<Category, string> = {
  "data-system-ml": "Дата + системная аналитика + ML",
  "marketing-sales": "Маркетинг + продажи",
  "erp-development": "Разработка ERP",
  "data-security": "Безопасность данных"
};

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function randomAvatarColor() {
  const colors = ["#2563eb", "#c2410c", "#6d28d9", "#be123c", "#1f8a70", "#0f766e", "#7c3aed"];
  return colors[Math.floor(Math.random() * colors.length)];
}
