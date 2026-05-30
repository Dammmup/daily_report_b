import "dotenv/config";
import { createApp } from "./app.js";
import { connectMongo } from "./mongo.js";
import { startTelegramBot } from "./telegram.js";

const port = Number(process.env.PORT || 4000);

connectMongo()
  .then(() => {
    createApp().listen(port, () => {
      console.log(`DailyReport ERP API: http://127.0.0.1:${port}`);
    });
    startTelegramBot();
  })
  .catch((error) => {
    console.error("MongoDB connection failed", error);
    process.exit(1);
  });
