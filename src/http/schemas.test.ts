import assert from "node:assert/strict";
import test from "node:test";
import {
  adminPlanSchema,
  adminUserUpdateSchema,
  attendanceSchema,
  departmentSchema,
  loginSchema,
  officeLocationSchema,
  passwordChangeSchema,
  planSchema,
  planStepCreateSchema,
  planStepUpdateSchema,
  profileUpdateSchema,
  reportSchema,
  requestCodeSchema,
  stepArtifactSchema,
  stepCommentSchema,
  surveySchema,
  verifyEmailSchema
} from "./schemas.js";

// --- Пользователи: регистрация / логин / верификация ---

test("requestCodeSchema requires email or phone and a strong password", () => {
  assert.equal(requestCodeSchema.safeParse({ name: "Иван", email: "a@b.com", password: "12345678" }).success, true);
  // короткий пароль
  assert.equal(requestCodeSchema.safeParse({ name: "Иван", email: "a@b.com", password: "123" }).success, false);
  // имя слишком короткое
  assert.equal(requestCodeSchema.safeParse({ name: "И", email: "a@b.com", password: "12345678" }).success, false);
  // ни email, ни телефона
  assert.equal(requestCodeSchema.safeParse({ name: "Иван", password: "12345678" }).success, false);
  // невалидный email
  assert.equal(requestCodeSchema.safeParse({ name: "Иван", email: "not-an-email", password: "12345678" }).success, false);
  // телефон вместо email
  assert.equal(requestCodeSchema.safeParse({ name: "Иван", phone: "+77001234567", password: "12345678" }).success, true);
});

test("verifyEmailSchema enforces a 6-char code and a contact", () => {
  assert.equal(verifyEmailSchema.safeParse({ email: "a@b.com", code: "123456" }).success, true);
  assert.equal(verifyEmailSchema.safeParse({ email: "a@b.com", code: "12345" }).success, false);
  assert.equal(verifyEmailSchema.safeParse({ code: "123456" }).success, false);
});

test("loginSchema bounds identifier and password length", () => {
  assert.equal(loginSchema.safeParse({ identifier: "a@b.com", password: "secret" }).success, true);
  assert.equal(loginSchema.safeParse({ identifier: "ab", password: "secret" }).success, false);
  assert.equal(loginSchema.safeParse({ identifier: "a@b.com", password: "x" }).success, false);
});

test("adminUserUpdateSchema accepts role/category changes and null category", () => {
  assert.equal(adminUserUpdateSchema.safeParse({ role: "lead" }).success, true);
  assert.equal(adminUserUpdateSchema.safeParse({ category: null }).success, true);
  assert.equal(adminUserUpdateSchema.safeParse({ category: "data-analytics" }).success, true);
  assert.equal(adminUserUpdateSchema.safeParse({ role: "owner" }).success, false);
  assert.equal(adminUserUpdateSchema.safeParse({ category: "nope" }).success, false);
  assert.equal(adminUserUpdateSchema.safeParse({}).success, true); // обе опциональны
});

test("profile and password schemas validate updates", () => {
  assert.equal(profileUpdateSchema.safeParse({ name: "Иван", avatarUrl: "https://x.io/a.png" }).success, true);
  assert.equal(profileUpdateSchema.safeParse({ name: "Иван", avatarUrl: "" }).success, true);
  assert.equal(profileUpdateSchema.safeParse({ name: "Иван", avatarUrl: "not-a-url" }).success, false);
  assert.equal(profileUpdateSchema.safeParse({ name: "И" }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "abcd", newPassword: "12345678" }).success, true);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "abcd", newPassword: "short" }).success, false);
});

test("departmentSchema validates category and optional reason bounds", () => {
  assert.equal(departmentSchema.safeParse({ category: "sales" }).success, true);
  assert.equal(departmentSchema.safeParse({ category: "sales", reason: "Нужна другая команда" }).success, true);
  assert.equal(departmentSchema.safeParse({ category: "sales", reason: "коротко" }).success, false); // < 10
  assert.equal(departmentSchema.safeParse({ category: "bad" }).success, false);
});

// --- Планы и шаги ---

test("planSchema validates title, ISO deadline and splits milestone text", () => {
  const ok = planSchema.safeParse({ title: "Запуск дашборда", baseDeadline: "2026-07-01", milestones: "Этап 1: сбор\nЭтап 2: модель" });
  assert.equal(ok.success, true);
  if (ok.success) assert.deepEqual(ok.data.milestones, ["Этап 1: сбор", "Этап 2: модель"]);

  assert.equal(planSchema.safeParse({ title: "кор", baseDeadline: "2026-07-01", milestones: ["a"] }).success, false); // title < 5
  assert.equal(planSchema.safeParse({ title: "Норм тайтл", baseDeadline: "01-07-2026", milestones: ["a"] }).success, false); // дата
  assert.equal(planSchema.safeParse({ title: "Норм тайтл", baseDeadline: "2026-07-01", milestones: [] }).success, false); // пусто
});

test("adminPlanSchema extends plan with category, lead and optional steps", () => {
  const base = { title: "План отдела", baseDeadline: "2026-08-01", milestones: ["Этап 1: a"], category: "machine-learning", leadId: "650000000000000000000001" };
  assert.equal(adminPlanSchema.safeParse(base).success, true);
  assert.equal(adminPlanSchema.safeParse({ ...base, category: "bad" }).success, false);
  assert.equal(adminPlanSchema.safeParse({ ...base, leadId: "" }).success, false);
  const withStep = {
    ...base,
    steps: [{ title: "Шаг", deadline: "2026-08-02", status: "todo", source: "manual" }]
  };
  assert.equal(adminPlanSchema.safeParse(withStep).success, true);
  // плохой статус шага
  assert.equal(adminPlanSchema.safeParse({ ...base, steps: [{ title: "Шаг", deadline: "2026-08-02", status: "wip" }] }).success, false);
});

test("plan step create/update schemas validate fields and deadline format", () => {
  assert.equal(planStepCreateSchema.safeParse({ title: "Шаг", deadline: "2026-08-02" }).success, true);
  assert.equal(planStepCreateSchema.safeParse({ title: "ab", deadline: "2026-08-02" }).success, false); // title < 3
  assert.equal(planStepCreateSchema.safeParse({ title: "Шаг", deadline: "bad" }).success, false);
  // update: все поля опциональны, assignedTo может быть null (снятие)
  assert.equal(planStepUpdateSchema.safeParse({}).success, true);
  assert.equal(planStepUpdateSchema.safeParse({ status: "done" }).success, true);
  assert.equal(planStepUpdateSchema.safeParse({ assignedTo: null }).success, true);
  assert.equal(planStepUpdateSchema.safeParse({ status: "bad" }).success, false);
});

// --- Отчёты / посещаемость / опрос / комментарии ---

test("reportSchema requires substantial yesterday/today text", () => {
  assert.equal(reportSchema.safeParse({ yesterday: "Сделал многое сегодня", todayPlan: "Планирую закончить отчёт", blockers: "" }).success, true);
  assert.equal(reportSchema.safeParse({ yesterday: "коротко", todayPlan: "Планирую закончить отчёт" }).success, false);
});

test("attendanceSchema validates mood and geo ranges", () => {
  assert.equal(attendanceSchema.safeParse({ mood: "focused", latitude: 43.2, longitude: 76.9, accuracyMeters: 12 }).success, true);
  assert.equal(attendanceSchema.safeParse({ mood: "happy" }).success, false);
  assert.equal(attendanceSchema.safeParse({ mood: "normal", latitude: 200 }).success, false);
});

test("officeLocationSchema applies radius and weekly defaults", () => {
  const parsed = officeLocationSchema.safeParse({ latitude: 43.2, longitude: 76.9 });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.radiusMeters, 150);
    assert.equal(parsed.data.minWeeklyOfficeDays, 2);
  }
  assert.equal(officeLocationSchema.safeParse({ latitude: 43.2, longitude: 76.9, radiusMeters: 10 }).success, false); // < 25
});

test("survey, comment and artifact schemas validate input", () => {
  assert.equal(
    surveySchema.safeParse({ traits: ["focus"], skills: "Python", experience: "1y", learningStyle: "видео", goal: "стать ML-инженером" }).success,
    true
  );
  assert.equal(stepCommentSchema.safeParse({ text: "Готово" }).success, true);
  assert.equal(stepCommentSchema.safeParse({ text: "" }).success, false);
  assert.equal(stepArtifactSchema.safeParse({ title: "Демо", url: "https://x.io/demo" }).success, true);
  assert.equal(stepArtifactSchema.safeParse({ title: "Демо", url: "not-a-url" }).success, false);
});
