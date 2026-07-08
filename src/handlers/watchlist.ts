import { Composer, InlineKeyboard } from "grammy";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";
import { tickerToCoinId, fuzzyMatchCoins } from "../price-feed.js";
import { shouldShowAI } from "../models.js";

// Watchlist management — view, add, remove, and manage alert rules per coin.
const composer = new Composer<Ctx>();

registerMainMenuItem({ label: "📋 Watchlist", data: "watchlist:menu", order: 20 });

// /watchlist command
composer.command("watchlist", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const store = getDomainStore();
  const entries = await store.getWatchlist(userId);

  if (entries.length === 0) {
    await ctx.reply("Your watchlist is empty — tap 📋 Watchlist on the menu to add coins.");
    return;
  }

  const lines: string[] = ["Your watchlist:"];
  for (const e of entries) {
    const status = e.enabled ? "🟢" : "🔴";
    const tc = e.thresholds.length;
    const pc = e.percents.length;
    lines.push(`${status} ${e.ticker} (${e.coinName}) — ${tc} threshold, ${pc} % alerts`);
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: inlineKeyboard([
      [inlineButton("📋 Open watchlist", "watchlist:menu")],
    ]),
  });
});

// ---- View watchlist ----

composer.callbackQuery("watchlist:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entries = await store.getWatchlist(userId);

  if (entries.length === 0) {
    await ctx.editMessageText(
      "Your watchlist is empty. Add coins to start tracking prices and setting alerts.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("➕ Add coin", "watchlist:add")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  // Build a summary per entry
  const lines: string[] = ["Your watchlist:"];
  for (const e of entries) {
    const status = e.enabled ? "🟢" : "🔴";
    const tc = e.thresholds.length;
    const pc = e.percents.length;
    lines.push(`${status} ${e.ticker} (${e.coinName}) — ${tc} threshold, ${pc} % alerts`);
  }

  // Build inline buttons: one row per coin
  const rows = entries.map((e) => [
    inlineButton(`${e.enabled ? "🟢" : "🔴"} ${e.ticker}`, `wl:view:${e.ticker}`),
  ]);
  rows.push([inlineButton("➕ Add coin", "watchlist:add")]);
  rows.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard(rows),
  });
});

// ---- Add coin ----
composer.callbackQuery("watchlist:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_ticker";
  await ctx.editMessageText("Enter a ticker symbol to add (e.g., BTC, ETH, SOL):", {
    reply_markup: inlineKeyboard([[inlineButton("Cancel", "menu:main")]]),
  });
});

// Free-form typed ticker from watchlist add
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_ticker") return next();
  const ticker = ctx.message.text.trim().toUpperCase();
  const info = tickerToCoinId(ticker);
  if (!info) {
    const suggestions = fuzzyMatchCoins(ticker);
    const hint = suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : "";
    await ctx.reply(`Unknown ticker "${ticker}".${hint} Try another or type /cancel.`);
    return;
  }

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const existing = await store.getWatchlistEntry(userId, ticker);
  if (existing) {
    ctx.session.step = "idle";
    await ctx.reply(`${ticker} is already in your watchlist.`, {
      reply_markup: inlineKeyboard([[inlineButton("View watchlist", "watchlist:menu")]]),
    });
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

  ctx.session.step = "idle";
  await ctx.reply(`✅ Added ${ticker} (${info.name}) to your watchlist.`, {
    reply_markup: inlineKeyboard([
      [inlineButton("Add threshold alert", `wl:addthresh:${ticker}`)],
      [inlineButton("Add % alert", `wl:addpct:${ticker}`)],
      [inlineButton("View watchlist", "watchlist:menu")],
    ]),
  });
});

// ---- View single coin ----
composer.callbackQuery(/^wl:view:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entry = await store.getWatchlistEntry(userId, ticker);

  if (!entry) {
    await ctx.editMessageText(`${ticker} is not in your watchlist.`, {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "watchlist:menu")]]),
    });
    return;
  }

  const status = entry.enabled ? "🟢 Enabled" : "🔴 Disabled";
  const lines: string[] = [
    `${entry.ticker} (${entry.coinName}) — ${status}`,
    "",
  ];

  if (entry.thresholds.length > 0) {
    lines.push("Threshold rules:");
    for (const r of entry.thresholds) {
      lines.push(`  • ${r.direction === "above" ? "↑ Above" : "↓ Below"} $${r.value}`);
    }
  } else {
    lines.push("No threshold rules.");
  }

  if (entry.percents.length > 0) {
    lines.push("Percentage rules:");
    for (const r of entry.percents) {
      lines.push(`  • ${r.direction === "up" ? "↗ Up" : r.direction === "down" ? "↘ Down" : "⇅ Either"} ${r.percent}%`);
    }
  } else {
    lines.push("No percentage rules.");
  }

  const profile = await store.getUser(userId);
  const aiAllowed = profile ? shouldShowAI(profile) : false;
  const aiOverrideCheck = entry.aiOverride;
  const showAI = aiAllowed && aiOverrideCheck !== false && !(aiAllowed && aiOverrideCheck === false);

  const rows = [
    [inlineButton("📈 Price check", `price:coin:${ticker}`)],
  ];

  if (showAI) {
    rows.push([inlineButton("🤖 AI opinion", `ai:recommend:${ticker}`)]);
  }

  rows.push(
    [inlineButton("➕ Add threshold alert", `wl:addthresh:${ticker}`)],
    [inlineButton("➕ Add % alert", `wl:addpct:${ticker}`)],
  );

  if (entry.thresholds.length > 0 || entry.percents.length > 0) {
    rows.push([inlineButton("🗑 Remove all rules", `wl:rmrules:${ticker}`)]);
  }

  rows.push([
    inlineButton(entry.enabled ? "🔴 Disable" : "🟢 Enable", `wl:toggle:${ticker}`),
  ]);
  rows.push([
    inlineButton("🗑 Remove from watchlist", `wl:remove:${ticker}`),
  ]);
  rows.push([inlineButton("⬅️ Back to watchlist", "watchlist:menu")]);

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard(rows),
  });
});

// ---- Toggle enable/disable ----
composer.callbackQuery(/^wl:toggle:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entry = await store.getWatchlistEntry(userId, ticker);
  if (!entry) return;

  entry.enabled = !entry.enabled;
  await store.upsertWatchlistEntry(userId, entry);

  // Refresh the view
  // Trigger a new callback to re-render
  const kb = ctx.callbackQuery.message?.reply_markup;
  await ctx.editMessageText(
    `${ticker} is now ${entry.enabled ? "enabled" : "disabled"}.`,
    { reply_markup: kb ?? inlineKeyboard([[inlineButton("⬅️ Back", "watchlist:menu")]]) },
  );
});

// ---- Remove from watchlist ----
composer.callbackQuery(/^wl:remove:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();
  await store.removeWatchlistEntry(userId, ticker);

  await ctx.editMessageText(`Removed ${ticker} from your watchlist.`, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "watchlist:menu")]]),
  });
});

// ---- Remove all rules ----
composer.callbackQuery(/^wl:rmrules:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entry = await store.getWatchlistEntry(userId, ticker);
  if (!entry) return;

  entry.thresholds = [];
  entry.percents = [];
  await store.upsertWatchlistEntry(userId, entry);

  await ctx.editMessageText(`All rules removed for ${ticker}.`, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", `wl:view:${ticker}`)]]),
  });
});

// ---- Add threshold alert: step 1 — direction ----
composer.callbackQuery(/^wl:addthresh:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  ctx.session.coin = ticker;
  ctx.session.ruleType = "threshold";
  ctx.session.step = "threshold_direction";

  const kb = inlineKeyboard([
    [inlineButton("↑ Above", `thresh:dir:${ticker}:above`)],
    [inlineButton("↓ Below", `thresh:dir:${ticker}:below`)],
    [inlineButton("Cancel", "watchlist:menu")],
  ]);
  await ctx.editMessageText(`Set a threshold alert for ${ticker}. When the price goes…`, {
    reply_markup: kb,
  });
});

// Threshold: direction chosen
composer.callbackQuery(/^thresh:dir:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  const ticker = parts[2];
  const direction = parts[3] as "above" | "below";
  ctx.session.coin = ticker;
  ctx.session.ruleDirection = direction;
  ctx.session.step = "threshold_price";

  await ctx.editMessageText(
    `${direction === "above" ? "↑ Above" : "↓ Below"} — at what price? Type the amount in USD:`,
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", `wl:view:${ticker}`)]]) },
  );
});

// Threshold: price typed
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "threshold_price") return next();
  if (!ctx.session.coin) return next();
  const ticker = ctx.session.coin;
  const direction = ctx.session.ruleDirection as "above" | "below";
  const text = ctx.message.text.trim().replace(/[, ]/g, "");
  const value = parseFloat(text);

  if (isNaN(value) || value <= 0) {
    await ctx.reply("Please enter a valid price (e.g., 50000 or 1000.50).");
    return;
  }

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entry = await store.getWatchlistEntry(userId, ticker);
  if (!entry) {
    await ctx.reply("Coin not found in your watchlist.");
    ctx.session.step = "idle";
    return;
  }

  const rule = {
    id: `t:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    direction,
    value,
  };

  entry.thresholds.push(rule);
  await store.upsertWatchlistEntry(userId, entry);
  ctx.session.step = "idle";

  await ctx.reply(
    `✅ Alert set: ${ticker} ${direction === "above" ? "↑ above" : "↓ below"} $${value}`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton(`View ${ticker}`, `wl:view:${ticker}`)],
        [inlineButton("⬅️ Watchlist", "watchlist:menu")],
      ]),
    },
  );
});

// ---- Add percentage alert: step 1 — direction ----
composer.callbackQuery(/^wl:addpct:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  ctx.session.coin = ticker;
  ctx.session.ruleType = "percent";
  ctx.session.step = "percent_direction";

  const kb = inlineKeyboard([
    [inlineButton("↗ Up", `pct:dir:${ticker}:up`)],
    [inlineButton("↘ Down", `pct:dir:${ticker}:down`)],
    [inlineButton("⇅ Either", `pct:dir:${ticker}:both`)],
    [inlineButton("Cancel", "watchlist:menu")],
  ]);
  await ctx.editMessageText(`Set a % alert for ${ticker}. Notify when price moves…`, {
    reply_markup: kb,
  });
});

// Percent: direction chosen
composer.callbackQuery(/^pct:dir:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  const ticker = parts[2];
  const direction = parts[3] as "up" | "down" | "both";
  ctx.session.coin = ticker;
  ctx.session.ruleDirection = direction;
  ctx.session.step = "percent_value";

  await ctx.editMessageText(
    `At what percentage change? Type a number (e.g., 5 for 5%):`,
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", `wl:view:${ticker}`)]]) },
  );
});

// Percent: value typed
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "percent_value") return next();
  if (!ctx.session.coin) return next();
  const ticker = ctx.session.coin;
  const direction = ctx.session.ruleDirection as "up" | "down" | "both";
  const text = ctx.message.text.trim();
  const value = parseFloat(text);

  if (isNaN(value) || value <= 0 || value > 100) {
    await ctx.reply("Please enter a valid percentage between 1 and 100 (e.g., 5).");
    return;
  }

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entry = await store.getWatchlistEntry(userId, ticker);
  if (!entry) {
    await ctx.reply("Coin not found in your watchlist.");
    ctx.session.step = "idle";
    return;
  }

  const rule = {
    id: `p:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    direction,
    percent: value,
  };

  entry.percents.push(rule);
  await store.upsertWatchlistEntry(userId, entry);
  ctx.session.step = "idle";

  const dirLabel = direction === "up" ? "↗ up" : direction === "down" ? "↘ down" : "⇅ either direction";
  await ctx.reply(
    `✅ Alert set: ${ticker} ${dirLabel} ${value}% or more (1h window)`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton(`View ${ticker}`, `wl:view:${ticker}`)],
        [inlineButton("⬅️ Watchlist", "watchlist:menu")],
      ]),
    },
  );
});

// Price check from coin view
composer.callbackQuery(/^price:coin:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const entry = await store.getWatchlistEntry(userId, ticker);
  if (!entry) return;

  const { defaultPriceFeed } = await import("../price-feed.js");
  const { formatPriceLine } = await import("../alerts.js");
  const feed = await defaultPriceFeed();
  const snap = await feed.getPrice(entry.coinId);

  if (!snap) {
    await ctx.editMessageText(`Couldn't fetch price for ${ticker}.`, {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", `wl:view:${ticker}`)]]),
    });
    return;
  }

  await ctx.editMessageText(formatPriceLine(snap.ticker, snap.coinName, snap.currentPrice, snap.percentChange1h), {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", `wl:view:${ticker}`)]]),
  });
});

export default composer;