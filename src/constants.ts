import type { Category } from "./types.js";
import { addIsoDays, businessDateIso } from "./date.js";

export const categoryValues = [
  "data-analytics",
  "system-analytics",
  "machine-learning",
  "marketing",
  "sales",
  "erp-development",
  "data-security"
] as const;

export const categories: Record<Category, string> = {
  "data-analytics": "Дата-аналитика",
  "system-analytics": "Системная аналитика",
  "machine-learning": "Машинное обучение",
  "marketing": "Маркетинг",
  "sales": "Продажи",
  "erp-development": "Разработка ERP",
  "data-security": "Безопасность данных"
};

export const legacyCategoryMap: Record<string, Category> = {
  "data-system-ml": "data-analytics",
  "marketing-sales": "marketing",
  "erp-development": "erp-development",
  "data-security": "data-security"
};

export function todayIso() {
  return businessDateIso();
}

export function addDays(date: string, days: number) {
  return addIsoDays(date, days);
}

export function randomAvatarColor() {
  const colors = ["#2563eb", "#c2410c", "#6d28d9", "#be123c", "#1f8a70", "#0f766e", "#7c3aed"];
  return colors[Math.floor(Math.random() * colors.length)];
}
