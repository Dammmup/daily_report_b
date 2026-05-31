import "dotenv/config";
import { createApp } from "./app.js";
import { connectMongo } from "./mongo.js";
import { startTelegramBot } from "./telegram.js";

const port = Number(process.env.PORT || 4000);
const app = createApp();

const isVercel = process.env.VERCEL === "1";

if (!isVercel) {
  connectMongo()
    .then(() => {
      app.listen(port, () => {
        console.log(`DailyReport ERP API: http://127.0.0.1:${port}`);
      });
      startTelegramBot();
    })
    .catch((error) => {
      console.error("MongoDB connection failed", error);
      process.exit(1);
    });
}

// Vercel Serverless handler. Telegram webhook is handled by the Express route.
export default async function handler(req: any, res: any) {
  try {
    await connectMongo();
  } catch (error) {
    console.error("Vercel Serverless init error:", error);
  }
  return app(req, res);
}
