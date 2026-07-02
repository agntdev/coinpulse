import { Composer } from "grammy";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";
import { tickerToCoinId } from "../price-feed.js";

// Quick-add coins to watchlist. Supports add_coin:BTC, add_coin:ETH, add_coin:TON
// callbacks from anywhere, plus serves as the "add coin" flow when a user wants
// to add a coin with alert options after onboarding.
const composer = new Composer<Ctx>();

// Quick-add BTC/ETH/TON from main menu buttons or onboarding
composer.callbackQuery(/^add_coin:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!.toUpperCase();
  const userId = ctx.from!.id;
  const store = getDomainStore();

  const profile = await store.getUser(userId);
  if (!profile || !profile.onboarded) {
    await ctx.editMessageText("Please /start first to set up your profile.", {
      reply_markup: inlineKeyboard([[inlineButton("🔄 Start setup", "menu:main")]]),
    });
    return;
  }

  const info = tickerToCoinId(ticker);
  if (!info) {
    await ctx.editMessageText(`Unknown ticker "${ticker}".`, {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "menu:main")]]),
    });
    return;
  }

  const existing = await store.getWatchlistEntry(userId, ticker);
  if (existing) {
    await ctx.editMessageText(
      `${ticker} (${info.name}) is already in your watchlist.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton(`View ${ticker}`, `wl:view:${ticker}`)],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  await store.upsertWatchlistEntry(userId, {
    ticker,
    coinName: info.name,
    coinId: info.id,
    enabled: true,
    thresholds: [],
    percents: [],
  });

  await ctx.editMessageText(
    `✅ Added ${ticker} (${info.name}) to your watchlist. Now set up alerts:`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔔 Add threshold alert", `wl:addthresh:${ticker}`)],
        [inlineButton("📊 Add % alert", `wl:addpct:${ticker}`)],
        [inlineButton("📋 View watchlist", "watchlist:menu")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;