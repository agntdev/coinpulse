import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";

// /stats — Owner-only analytics dashboard. Shows total users, top-fired tickers,
// and recent alert examples. Restricted by OWNER_TELEGRAM_ID env var.

const composer = new Composer<Ctx>();

const OWNER_ID = parseInt(process.env.OWNER_TELEGRAM_ID ?? "0", 10);

composer.command("stats", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || userId !== OWNER_ID) {
    await ctx.reply("This command is only available to the bot owner.");
    return;
  }

  const store = getDomainStore();
  const telemetry = await store.getTelemetry();

  const lines: string[] = [
    `📊 CryptoWatch — Owner Analytics`,
    ``,
    `Total users: ${telemetry.totalUsers}`,
    ``,
  ];

  // Top 20 most-fired tickers
  const sortedTickers = Object.entries(telemetry.tickerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20);

  if (sortedTickers.length > 0) {
    lines.push(`Top tickers by alert count:`);
    for (const [ticker, count] of sortedTickers) {
      lines.push(`  ${ticker}: ${count} alerts`);
    }
    lines.push(``);
  }

  // Top rules
  const sortedRules = Object.entries(telemetry.ruleCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (sortedRules.length > 0) {
    lines.push(`Top rule types:`);
    for (const [rule, count] of sortedRules) {
      lines.push(`  ${rule}: ${count} times`);
    }
    lines.push(``);
  }

  // Recent alert examples
  const recentAlerts = telemetry.recentAlerts.slice(0, 5);
  if (recentAlerts.length > 0) {
    lines.push(`Recent alerts (${telemetry.recentAlerts.length} total in last 90 days):`);
    for (const a of recentAlerts) {
      const date = new Date(a.timestamp).toISOString().slice(0, 16).replace("T", " ");
      const delivered = a.delivered ? "✅" : "❌";
      lines.push(`  ${date} ${a.ticker} — $${a.oldPrice}→$${a.newPrice} (${a.percentChange.toFixed(1)}%) ${delivered}`);
    }
  } else {
    lines.push(`No alerts fired yet.`);
  }

  await ctx.reply(lines.join("\n"));
});

export default composer;