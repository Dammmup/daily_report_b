import "dotenv/config";
import mongoose from "mongoose";
import { UserModel } from "./models/user.model.js";
import { AttendanceModel } from "./models/attendance.model.js";
import { PlanModel } from "./models/plan.model.js";
import { ReportModel } from "./models/report.model.js";

import { hashPassword } from "./auth.js";

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  console.error("Ошибка: MONGODB_URI не задан в переменных окружения!");
  process.exit(1);
}

async function run() {
  try {
    console.log("Подключение к MongoDB...");
    await mongoose.connect(mongoUri as string);
    console.log("Успешно подключено к базе данных.");

    console.log("Очистка и обновление индексов...");
    await UserModel.cleanIndexes();

    console.log("Очистка существующих коллекций...");
    const usersDel = await UserModel.deleteMany({});
    const attDel = await AttendanceModel.deleteMany({});
    const planDel = await PlanModel.deleteMany({});
    const repDel = await ReportModel.deleteMany({});

    console.log(`Удалено:
  - Пользователей: ${usersDel.deletedCount}
  - Посещений: ${attDel.deletedCount}
  - Планов: ${planDel.deletedCount}
  - Отчетов: ${repDel.deletedCount}`);

    console.log("Создание тимлида Кийкжан...");
    const kiykzhan = await UserModel.create({
      name: "Кийкжан",
      email: "lead@erp.local",
      role: "lead",
      avatarColor: "#1f8a70",
      firstLoginCompleted: true,
      emailVerified: true,
      passwordHash: hashPassword("1234"),
      lastActiveAt: new Date()
    });

    console.log(`Тимлид Кийкжан успешно создан! ID: ${kiykzhan._id}`);
    console.log("База данных успешно очищена и инициализирована.");
    process.exit(0);
  } catch (error) {
    console.error("Произошла ошибка при очистке и заполнении базы данных:", error);
    process.exit(1);
  }
}

run();
