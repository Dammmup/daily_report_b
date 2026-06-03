import mongoose from "mongoose";
import { hashPassword } from "./auth.js";
import { legacyCategoryMap } from "./constants.js";
import {
  AttendanceModel,
  AuditLogModel,
  PlanModel,
  ReportModel,
  StepArtifactModel,
  StepCommentModel,
  SurveyModel,
  TelegramActivityModel,
  UserModel
} from "./models.js";

let connectPromise: Promise<typeof mongoose> | undefined;
let bootstrapPromise: Promise<void> | undefined;

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return;
  }
  const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/dailyreport_erp";
  mongoose.set("strictQuery", true);

  connectPromise ||= mongoose.connect(mongoUri, { dbName: process.env.MONGODB_DB || "dailyreport" });
  await connectPromise;

  bootstrapPromise ||= bootstrapDatabase();
  await bootstrapPromise;
}

async function bootstrapDatabase() {
  await migrateLegacyCategories();
  await mergeTelegramShadowUsers();
  await dropLegacyPlanCategoryUniqueIndex();
  await dropLegacyPlanUserIdUniqueIndex();
  await seedAdmin();
}

async function migrateLegacyCategories() {
  const collections = ["users", "plans", "telegramgroups", "officelocations", "planchanges", "auditlogs"];
  for (const [from, to] of Object.entries(legacyCategoryMap)) {
    for (const collectionName of collections) {
      await mongoose.connection.db?.collection(collectionName).updateMany({ category: from }, { $set: { category: to } });
    }
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const translitMap: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ы: "y",
  э: "e",
  ю: "yu",
  я: "ya",
  ъ: "",
  ь: ""
};

function normalizedName(value = "") {
  return value
    .toLowerCase()
    .trim()
    .split("")
    .map((char) => translitMap[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= b.length; column += 1) dp[0][column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      dp[row][column] = Math.min(
        dp[row - 1][column] + 1,
        dp[row][column - 1] + 1,
        dp[row - 1][column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function namesLookSimilar(left: string, right: string) {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (a.length < 3 || b.length < 3) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return levenshtein(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.25));
}

function createdWithinHours(left?: Date, right?: Date, hours = 8) {
  if (!left || !right) return false;
  return Math.abs(left.getTime() - right.getTime()) <= hours * 60 * 60 * 1000;
}

async function findVerifiedUserForTelegramShadow(shadow: Awaited<ReturnType<typeof UserModel.findOne>>) {
  if (!shadow) return null;

  if (shadow.telegramUsername) {
    const byUsername = await UserModel.findOne({
      _id: { $ne: shadow._id },
      emailVerified: true,
      telegramUsername: shadow.telegramUsername
    });
    if (byUsername) return byUsername;
  }

  if (!shadow.name || !shadow.category) return null;
  const exactName = await UserModel.find({
    _id: { $ne: shadow._id },
    emailVerified: true,
    name: new RegExp(`^${escapeRegex(shadow.name.trim())}$`, "i"),
    category: shadow.category
  }).limit(2);

  if (exactName.length === 1 && createdWithinHours(exactName[0].createdAt, shadow.createdAt)) return exactName[0];

  const candidates = await UserModel.find({
    _id: { $ne: shadow._id },
    emailVerified: true,
    email: { $exists: true, $ne: "" },
    category: shadow.category,
    createdAt: {
      $gte: new Date(shadow.createdAt.getTime() - 8 * 60 * 60 * 1000),
      $lte: new Date(shadow.createdAt.getTime() + 8 * 60 * 60 * 1000)
    }
  });
  const phoneticMatches = candidates.filter((user) => namesLookSimilar(user.name, shadow.name));
  return phoneticMatches.length === 1 ? phoneticMatches[0] : null;
}

async function mergeTelegramShadowUsers() {
  const shadows = await UserModel.find({
    registrationSource: "telegram_group",
    emailVerified: false,
    $or: [{ email: { $exists: false } }, { email: null }, { email: "" }]
  });

  let merged = 0;
  for (const shadow of shadows) {
    const target = await findVerifiedUserForTelegramShadow(shadow);
    if (!target) continue;

    target.telegramChatId = target.telegramChatId || shadow.telegramChatId;
    target.telegramUserId = target.telegramUserId || shadow.telegramUserId;
    target.telegramUsername = target.telegramUsername || shadow.telegramUsername;
    target.telegramGroupChatId = target.telegramGroupChatId || shadow.telegramGroupChatId;
    target.telegramActivityMessages = Math.max(target.telegramActivityMessages || 0, shadow.telegramActivityMessages || 0);
    target.telegramActivityScore = Math.max(target.telegramActivityScore || 0, shadow.telegramActivityScore || 0);
    target.telegramActivitySummary = target.telegramActivitySummary || shadow.telegramActivitySummary || "";
    target.telegramLastGroupSeenAt = target.telegramLastGroupSeenAt || shadow.telegramLastGroupSeenAt;
    target.lastActiveAt = target.lastActiveAt > shadow.lastActiveAt ? target.lastActiveAt : shadow.lastActiveAt;

    await Promise.all([
      TelegramActivityModel.updateMany({ userId: shadow._id }, { $set: { userId: target._id } }),
      ReportModel.updateMany({ userId: shadow._id }, { $set: { userId: target._id } }),
      AttendanceModel.updateMany({ userId: shadow._id }, { $set: { userId: target._id } }),
      SurveyModel.updateMany({ userId: shadow._id }, { $set: { userId: target._id } }),
      StepCommentModel.updateMany({ userId: shadow._id }, { $set: { userId: target._id } }),
      StepArtifactModel.updateMany({ userId: shadow._id }, { $set: { userId: target._id } }),
      AuditLogModel.updateMany({ actorId: shadow._id }, { $set: { actorId: target._id } }),
      PlanModel.updateMany(
        { "steps.assignedTo": shadow._id },
        { $set: { "steps.$[step].assignedTo": target._id } },
        { arrayFilters: [{ "step.assignedTo": shadow._id }] }
      )
    ]);

    await target.save();
    await UserModel.deleteOne({ _id: shadow._id });
    merged += 1;
  }

  if (merged) console.log(`MongoDB migrated: merged ${merged} Telegram shadow users.`);
}

async function dropLegacyPlanCategoryUniqueIndex() {
  try {
    await PlanModel.collection.dropIndex("category_1");
    console.log("MongoDB migrated: dropped legacy unique plan category index.");
  } catch {
    // The index may not exist on fresh databases.
  }
}

async function dropLegacyPlanUserIdUniqueIndex() {
  try {
    await PlanModel.collection.dropIndex("userId_1");
    console.log("MongoDB migrated: dropped legacy unique plan userId index.");
  } catch {
    // The index may not exist.
  }
}

async function seedAdmin() {
  const existingAdmin = await UserModel.findOne({ role: "admin" });
  if (existingAdmin) return;

  const adminEmail = process.env.ADMIN_EMAIL || "admin@erp.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin1234";

  await UserModel.create({
    name: "Администратор",
    email: adminEmail,
    role: "admin",
    avatarColor: "#172033",
    firstLoginCompleted: true,
    emailVerified: true,
    passwordHash: hashPassword(adminPassword),
    lastActiveAt: new Date()
  });

  console.log(`MongoDB seeded: admin created (${adminEmail}).`);
}
