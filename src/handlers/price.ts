import { Composer } from "grammy";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";
import { defaultPriceFeed, tickerToCoinId, fuzzyMatchCoins } from "../price-feed.js";
import { formatPriceLine } from "../alerts.js";
import { defaultClock } from "../clock.js";

// Price check handler — supports /price [ticker] and button-based flow.
const composer = new Composer<Ctx>();

registerMainMenuItem({ label: "💰 Price check", data: "price:menu", order: 10 });

composer.command("price", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile || !profile.onboarded) {
    await ctx.reply("Please /start first to set up your profile.");
    return;
  }

  const text = ctx.message?.text?.trim() ?? "";
  const parts = text.split(/\s+/);
  const arg = parts.length > 1 ? parts.slice(1).join(" ").trim() : null;

  if (arg && arg.toLowerCase() !== "all") {
    const ticker = arg.toUpperCase();
    const info = tickerToCoinId(ticker);
    if (!info) {
      const suggestions = fuzzyMatchCoins(ticker);
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(", ")}?`
        : "";
      await ctx.reply(`Unknown ticker "${arg.toUpperCase()}".${hint}`);
      return;
    }

    const feed = await defaultPriceFeed();
    const snap = await feed.getPrice(info.id);
    if (!snap) {
      await ctx.reply("Couldn't fetch that price right now — try again later.");
      return;
    }

    const entry = await store.getWatchlistEntry(userId, ticker);
    let rulesStatus = "";
    if (entry) {
      const activeThresholds = entry.thresholds.filter(t => {
        if (!t.lastFiredAt) return true;
        return defaultClock.nowMs() - t.lastFiredAt >= profile.cooldownMin * 60_000;
      }).length;
      const totalThresholds = entry.thresholds.length;
      const activePercents = entry.percents.filter(t => {
        if (!t.lastFiredAt) return true;
        return defaultClock.nowMs() - t.lastFiredAt >= profile.cooldownMin * 60_000;
      }).length;
      const totalPercents = entry.percents.length;

      if (totalThresholds > 0 || totalPercents > 0) {
        rulesStatus = `\n\nRules: ${activeThresholds}/${totalThresholds} thresholds, ${activePercents}/${totalPercents} % alerts active`;
      }
    }

    await ctx.reply(formatPriceLine(snap.ticker, snap.coinName, snap.currentPrice, snap.percentChange1h) + rulesStatus);
  } else {
    const entries = await store.getWatchlist(userId);
    if (entries.length === 0) {
      await ctx.reply("Your watchlist is empty — tap the menu to add coins.");
      return;
    }

    const feed = await defaultPriceFeed();
    const coinIds = entries.map(e => e.coinId);
    const prices = await feed.getPrices(coinIds);

    if (prices.size === 0) {
      await ctx.reply("Couldn't fetch prices right now — try again later.");
      return;
    }

    const lines: string[] = ["Your watchlist prices:"];
    for (const entry of entries) {
      const snap = prices.get(entry.coinId);
      if (snap) {
        lines.push(formatPriceLine(snap.ticker, snap.coinName, snap.currentPrice, snap.percentChange1h));
      } else {
        lines.push(`${entry.ticker}: price unavailable`);
      }
    }
    await ctx.reply(lines.join("\n"));
  }
});

// Price check button from main menu
composer.callbackQuery("price:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entries = await store.getWatchlist(userId);

  if (entries.length === 0) {
    await ctx.editMessageText(
      "Your watchlist is empty. Add coins from the Watchlist menu, or type /price <ticker>.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const feed = await defaultPriceFeed();
  const coinIds = entries.map(e => e.coinId);
  const prices = await feed.getPrices(coinIds);

  const lines: string[] = ["Your watchlist prices:"];
  for (const entry of entries) {
    const snap = prices.get(entry.coinId);
    if (snap) {
      lines.push(formatPriceLine(snap.ticker, snap.coinName, snap.currentPrice, snap.percentChange1h));
    } else {
      lines.push(`${entry.ticker}: price unavailable`);
    }
  }

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

export default composer;