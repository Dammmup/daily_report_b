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

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return;
  }
  const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/dailyreport_erp";
  mongoose.set("strictQuery", true);

  connectPromise ||= mongoose.connect(mongoUri, { dbName: process.env.MONGODB_DB || "dailyreport" });
  await connectPromise;
}

export async function runDatabaseBootstrap() {
  await migrateLegacyCategories();
  await mergeTelegramShadowUsers();
  await dropLegacyPlanCategoryUniqueIndex();
  await dropLegacyPlanUserIdUniqueIndex();
  await dedupeDailyReports();
  await syncModelIndexes();
  await seedAdmin();
}

// Удаляем исторические дубликаты дэйликов (userId+date), оставляя самый ранний,
// иначе уникальный индекс {userId,date} не построится.
async function dedupeDailyReports() {
  const duplicates = await ReportModel.aggregate<{ ids: unknown[] }>([
    { $sort: { createdAt: 1 } },
    { $group: { _id: { userId: "$userId", date: "$date" }, ids: { $push: "$_id" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  let removed = 0;
  for (const group of duplicates) {
    const [, ...extra] = group.ids;
    if (extra.length) {
      const result = await ReportModel.deleteMany({ _id: { $in: extra } });
      removed += result.deletedCount || 0;
    }
  }
  if (removed) console.log(`MongoDB migrated: removed ${removed} duplicate daily report(s).`);
}

// Приводим индексы коллекции отчётов к схеме (в т.ч. новый уникальный индекс {userId,date}).
async function syncModelIndexes() {
  try {
    await ReportModel.syncIndexes();
    console.log("MongoDB migrated: report indexes synced.");
  } catch (error) {
    console.warn("MongoDB report index sync skipped:", error);
  }
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

function normalizedNameTokens(value = "") {
  return value
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((part) => normalizedName(part))
    .filter(Boolean);
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
  const aTokens = normalizedNameTokens(left);
  const bTokens = normalizedNameTokens(right);
  if (a.length < 3 || b.length < 3) return false;
  if (aTokens.length > 1 && bTokens.length > 1 && aTokens.sort().join("") === bTokens.sort().join("")) return true;
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

async function telegramIdentityIsAvailable(field: "telegramUserId" | "telegramUsername", value: string | undefined | null, targetId: unknown, shadowId: unknown) {
  if (!value) return false;
  const owner = await UserModel.findOne({
    _id: { $nin: [targetId, shadowId] },
    [field]: value
  }).select("_id name");
  return !owner;
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

    try {
      const canCarryTelegramUserId =
        !target.telegramUserId && (await telegramIdentityIsAvailable("telegramUserId", shadow.telegramUserId, target._id, shadow._id));
      const canCarryTelegramUsername =
        !target.telegramUsername && (await telegramIdentityIsAvailable("telegramUsername", shadow.telegramUsername, target._id, shadow._id));

      target.telegramChatId = target.telegramChatId || shadow.telegramChatId;
      if (canCarryTelegramUserId) target.telegramUserId = shadow.telegramUserId;
      if (canCarryTelegramUsername) target.telegramUsername = shadow.telegramUsername;
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

      await UserModel.updateOne(
        { _id: shadow._id },
        {
          $unset: {
            telegramUserId: "",
            telegramUsername: "",
            telegramChatId: "",
            telegramLinkToken: ""
          }
        }
      );
      await target.save();
      await UserModel.deleteOne({ _id: shadow._id });
      merged += 1;
    } catch (error) {
      console.warn(`MongoDB migration skipped Telegram shadow user ${shadow._id}:`, error);
    }
  }

  if (merged) console.log(`MongoDB migrated: merged ${merged} Telegram shadow users.`);
}

async function dropLegacyPlanCategoryUniqueIndex() {
  try {
    const index = (await PlanModel.collection.indexes()).find((item) => item.name === "category_1");
    if (!index?.unique) return;
    await PlanModel.collection.dropIndex("category_1");
    console.log("MongoDB migrated: dropped legacy unique plan category index.");
  } catch {
    // The index may not exist on fresh databases.
  }
}

async function dropLegacyPlanUserIdUniqueIndex() {
  try {
    const index = (await PlanModel.collection.indexes()).find((item) => item.name === "userId_1");
    if (!index?.unique) return;
    await PlanModel.collection.dropIndex("userId_1");
    console.log("MongoDB migrated: dropped legacy unique plan userId index.");
  } catch {
    // The index may not exist.
  }
}

async function seedAdmin() {
  const existingAdmin = await UserModel.findOne({ role: "admin" });
  if (existingAdmin) return;

  const production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  const adminEmail = process.env.ADMIN_EMAIL?.trim() || (production ? "" : "admin@erp.local");
  const adminPassword = process.env.ADMIN_PASSWORD || (production ? "" : "admin1234");
  if (!adminEmail || !adminPassword) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be configured before creating the production admin");
  }
  if (production && (adminPassword.length < 12 || adminPassword === "change-this-admin-password" || adminPassword === "admin1234")) {
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters in production");
  }

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
