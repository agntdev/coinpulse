import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startScheduler, createDeliver } from "./scheduler.js";
import { getDomainStore } from "./store.js";
import { defaultPriceFeed } from "./price-feed.js";
import { defaultClock } from "./clock.js";
import { createAlertEngine } from "./alerts.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);

  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  // /price, /watchlist, /quiet, /summary are power-user shortcuts for free-form input,
  // and /stats is owner-only.
  await setDefaultCommands(bot, [
    { command: "price", description: "Check crypto prices" },
    { command: "watchlist", description: "View your watchlist" },
    { command: "quiet", description: "Set quiet hours" },
    { command: "summary", description: "Set morning summary" },
    { command: "stats", description: "Owner analytics (owner only)" },
  ]);

  // Start the background scheduler for alert checking and summaries
  const scheduler = startScheduler(bot);

  // Graceful shutdown
  const shutdown = () => {
    scheduler.stop();
    bot.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});