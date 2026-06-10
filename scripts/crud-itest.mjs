/**
 * Интеграционный CRUD-прогон против РЕАЛЬНОЙ MongoDB.
 *
 * Зачем: в песочнице Cowork нет сети для скачивания mongod, поэтому здесь это не
 * запускалось. Скрипт готов к запуску локально, где есть Mongo.
 *
 * Запуск:
 *   1) поднимите mongod (например: docker run -d -p 27017:27017 mongo:7)
 *   2) cd daily_report_b && npm run build
 *   3) MONGODB_URI="mongodb://127.0.0.1:27017" MONGODB_DB="dailyreport_itest" \
 *      node scripts/crud-itest.mjs
 *
 * Скрипт создаёт временную БД, прогоняет CRUD по пользователям/планам/шагам/отчётам
 * и проверяет ключевые фиксы (уникальность дэйлика, ревокация токена, CSRF, CastError→400),
 * печатает таблицу PASS/FAIL и выходит с кодом 1 при любой ошибке.
 */
import assert from "node:assert/strict";

// --- окружение задаём ДО импорта собранного приложения (модули читают env при загрузке) ---
process.env.NODE_ENV = "test";
process.env.VERCEL = "";
process.env.JWT_SECRET ||= "itest-jwt-secret-please-rotate";
process.env.OAUTH_STATE_SECRET ||= "itest-oauth-state-secret";
process.env.ADMIN_EMAIL ||= "admin@itest.local";
process.env.ADMIN_PASSWORD ||= "itest-admin-12345";
process.env.ALLOW_DEV_VERIFICATION_CODE = "true";
process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ||= "dailyreport_itest";

const { createApp } = await import("../dist/app.js");
const { connectMongo, runDatabaseBootstrap } = await import("../dist/mongo.js");
const mongoose = (await import("mongoose")).default;

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// --- мини-клиент с куки-джаром на «сессию» ---
function makeClient(baseUrl) {
  let cookie = "";
  return {
    async req(method, path, { body, origin, bearer } = {}) {
      const headers = { "Content-Type": "application/json" };
      if (cookie) headers.Cookie = cookie;
      if (origin) headers.Origin = origin;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookies = res.headers.getSetCookie?.() || [];
      for (const c of setCookies) {
        const pair = c.split(";")[0];
        if (pair.startsWith("dailyreport_session=")) cookie = pair;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
  };
}

async function main() {
  await connectMongo();
  // чистая временная БД
  await mongoose.connection.dropDatabase();
  await runDatabaseBootstrap();

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient(base);
  const lead = makeClient(base);
  const intern = makeClient(base);

  try {
    // health
    const health = await admin.req("GET", "/api/health");
    check("GET /api/health → 200", health.status === 200);

    // --- ПОЛЬЗОВАТЕЛИ: регистрация интерна ---
    const reg = await intern.req("POST", "/api/auth/request-code", {
      body: { name: "Интерн Тест", email: "intern@itest.local", password: "intern-12345" }
    });
    check("POST /auth/request-code (intern) → ok + devCode", reg.status === 200 && reg.json?.devCode, `status ${reg.status}`);
    const verify = await intern.req("POST", "/api/auth/verify", { body: { email: "intern@itest.local", code: reg.json.devCode } });
    check("POST /auth/verify (intern) → 200 + role intern", verify.status === 200 && verify.json?.user?.role === "intern");
    const internId = verify.json?.user?.id;
    const internOldToken = verify.json?.token;

    const me = await intern.req("GET", "/api/me");
    check("GET /me by cookie → 200", me.status === 200 && me.json?.user?.id === internId);

    // --- ПОЛЬЗОВАТЕЛИ: регистрация второго (станет лидом) ---
    const reg2 = await lead.req("POST", "/api/auth/request-code", {
      body: { name: "Лид Тест", email: "lead@itest.local", password: "lead-123456" }
    });
    await lead.req("POST", "/api/auth/verify", { body: { email: "lead@itest.local", code: reg2.json.devCode } });
    const leadMe = await lead.req("GET", "/api/me");
    const leadId = leadMe.json?.user?.id;

    // --- АДМИН логинится ---
    const adminLogin = await admin.req("POST", "/api/auth/login", {
      body: { identifier: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
    });
    check("POST /auth/login (admin) → 200", adminLogin.status === 200 && adminLogin.json?.user?.role === "admin");

    // READ список пользователей
    const users = await admin.req("GET", "/api/admin/users");
    check("GET /admin/users → список с интерном и лидом", users.status === 200 && users.json.length >= 3);

    // UPDATE: повышаем второго до лида + департамент
    const promote = await admin.req("PATCH", `/api/admin/users/${leadId}`, { body: { role: "lead", category: "data-analytics" } });
    check("PATCH /admin/users/:id → роль lead + категория", promote.status === 200 && promote.json?.user?.role === "lead" && promote.json?.user?.category === "data-analytics");

    // UPDATE: интерну ставим тот же департамент
    const setDept = await admin.req("PATCH", `/api/admin/users/${internId}`, { body: { category: "data-analytics" } });
    check("PATCH /admin/users/:id → категория интерну", setDept.status === 200 && setDept.json?.user?.category === "data-analytics");

    // защита: невалидный ObjectId → 400 (а не 500)
    const badId = await admin.req("GET", "/api/admin/interns/not-an-objectid");
    check("GET /admin/interns/:badId → 400 (CastError→400)", badId.status === 400, `status ${badId.status}`);

    // защита: нельзя снять с себя роль админа
    const selfDemote = await admin.req("PATCH", `/api/admin/users/${adminLogin.json.user.id}`, { body: { role: "lead" } });
    check("PATCH self-demote admin → 400", selfDemote.status === 400);

    // --- ПЛАНЫ: лид перелогинивается (роль обновилась) и создаёт план ---
    await lead.req("POST", "/api/auth/login", { body: { identifier: "lead@itest.local", password: "lead-123456" } });
    const planCreate = await lead.req("POST", "/api/department-plan", {
      body: { title: "Аналитический дашборд", baseDeadline: "2026-12-01", milestones: "Этап 1: сбор данных\nЭтап 2: визуализация" }
    });
    check("POST /department-plan (lead) → 201 + шаги", planCreate.status === 201 && planCreate.json?.steps?.length >= 2, `status ${planCreate.status}`);
    const planId = planCreate.json?.id;

    const myPlan = await lead.req("GET", "/api/my-plan");
    check("GET /my-plan → созданный план", myPlan.status === 200 && myPlan.json?.id === planId);

    // CREATE шаг
    const addStep = await lead.req("POST", `/api/department-plan/${planId}/steps`, {
      body: { title: "Подготовить макет", deadline: "2026-11-01" }
    });
    check("POST /department-plan/:id/steps → 201", addStep.status === 201);
    const steps = addStep.json?.steps || [];
    const newStep = steps[steps.length - 1];

    // UPDATE шаг: назначаем интерна
    const assign = await lead.req("PATCH", `/api/department-plan/steps/${newStep.id}`, { body: { assignedTo: internId } });
    const assignedStep = assign.json?.steps?.find((s) => s.id === newStep.id);
    check("PATCH step assignedTo intern → 200", assign.status === 200 && assignedStep?.assignedTo === internId);

    // защита: назначение не из департамента → 400
    const badAssign = await lead.req("PATCH", `/api/department-plan/steps/${newStep.id}`, { body: { assignedTo: adminLogin.json.user.id } });
    check("PATCH step assignedTo (admin not in dept) → 400", badAssign.status === 400);

    // --- ОТЧЁТЫ: интерн создаёт дэйлик ---
    await intern.req("POST", "/api/auth/login", { body: { identifier: "intern@itest.local", password: "intern-12345" } });
    const report1 = await intern.req("POST", "/api/reports", {
      body: { yesterday: "Изучил требования к дашборду", todayPlan: "Начну собирать данные сегодня", blockers: "", linkedStepIds: [newStep.id] }
    });
    check("POST /reports (intern) → 201", report1.status === 201, `status ${report1.status}`);

    // ФИКС #2: повтор дэйлика за день → 409 (уникальный индекс)
    const report2 = await intern.req("POST", "/api/reports", {
      body: { yesterday: "Повторная отправка за тот же день", todayPlan: "Должна отклониться дубликатом", blockers: "" }
    });
    check("POST /reports повторно за день → 409 (unique index)", report2.status === 409, `status ${report2.status}`);

    // --- ФИКС #6: CSRF — мутирующий запрос с чужим Origin → 403 ---
    const csrf = await intern.req("POST", "/api/reports", { origin: "https://evil.example", body: { yesterday: "x", todayPlan: "y" } });
    check("POST с чужим Origin → 403 (CSRF guard)", csrf.status === 403, `status ${csrf.status}`);

    // --- ФИКС #5: смена пароля ревокирует старые токены ---
    const pwd = await intern.req("PATCH", "/api/me/password", { body: { currentPassword: "intern-12345", newPassword: "intern-new-99999" } });
    check("PATCH /me/password → 200 + новый токен", pwd.status === 200 && pwd.json?.token);
    const oldTokenCheck = await makeClient(base).req("GET", "/api/me", { bearer: internOldToken });
    check("Старый токен после смены пароля → 401 (revocation)", oldTokenCheck.status === 401, `status ${oldTokenCheck.status}`);

    // --- DELETE: админ удаляет пользователя (баг-фикс: раньше кнопка ничего не делала) ---
    const throwaway = makeClient(base);
    const tReg = await throwaway.req("POST", "/api/auth/request-code", {
      body: { name: "Удаляемый Стажер", email: "delete-me@itest.local", password: "delete-12345" }
    });
    const tVerify = await throwaway.req("POST", "/api/auth/verify", { body: { email: "delete-me@itest.local", code: tReg.json.devCode } });
    const throwawayId = tVerify.json?.user?.id;
    const delUser = await admin.req("DELETE", `/api/admin/users/${throwawayId}`);
    check("DELETE /admin/users/:id → ok", delUser.status === 200 && delUser.json?.ok === true, `status ${delUser.status}`);
    const usersAfter = await admin.req("GET", "/api/admin/users");
    check("GET /admin/users → пользователь удалён", usersAfter.status === 200 && !usersAfter.json.some((u) => u.id === throwawayId));
    const selfDelete = await admin.req("DELETE", `/api/admin/users/${adminLogin.json.user.id}`);
    check("DELETE self (admin) → 400", selfDelete.status === 400);

    // --- DELETE: админ удаляет план ---
    const delPlan = await admin.req("DELETE", `/api/admin/plans/${planId}`);
    check("DELETE /admin/plans/:id → ok", delPlan.status === 200 && delPlan.json?.ok === true);
    const goneList = await admin.req("GET", "/api/admin/plans");
    check("GET /admin/plans → план удалён", goneList.status === 200 && !goneList.json.some((p) => p.id === planId));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок прошло.`);
  if (failed.length) {
    console.error("Провалены:", failed.map((r) => r.name).join("; "));
    process.exit(1);
  }
  console.log("Все CRUD-проверки прошли ✅");
}

main().catch((error) => {
  console.error("Интеграционный прогон упал:", error);
  process.exit(1);
});
