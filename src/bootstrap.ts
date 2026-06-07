import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, runDatabaseBootstrap } from "./mongo.js";

async function main() {
  await connectMongo();
  await runDatabaseBootstrap();
  await mongoose.disconnect();
  console.log("MongoDB bootstrap completed.");
}

main().catch(async (error) => {
  console.error("MongoDB bootstrap failed", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
