import mongoose from "mongoose";
import { hashPassword } from "./auth.js";
import { UserModel } from "./models.js";

let connectPromise: Promise<typeof mongoose> | undefined;
let bootstrapPromise: Promise<void> | undefined;

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return;
  }
  const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/dailyreport_erp";
  mongoose.set("strictQuery", true);

  connectPromise ||= mongoose.connect(mongoUri);
  await connectPromise;

  bootstrapPromise ||= seedAdmin();
  await bootstrapPromise;
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
