import { Composer } from "grammy";
import {
  registerMainMenuItem,
  mainMenuKeyboard,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";
import { defaultClock } from "../clock.js";

// /start — Onboarding and main menu.
const composer = new Composer<Ctx>();

const WELCOME_KNOWN = "👋 Welcome back! Tap a button below to get started.";

// "Back to menu" — must be registered early so it works from anywhere.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await ctx.editMessageText(WELCOME_KNOWN, { reply_markup: mainMenuKeyboard() });
});

composer.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (profile && profile.onboarded) {
    ctx.session.step = "idle";
    await ctx.reply(WELCOME_KNOWN, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Fresh onboarding: step 1 — currency
  ctx.session.step = "onboarding_currency";
  const currencyKb = inlineKeyboard([
    [inlineButton("🇺🇸 USD", "onboard:currency:usd")],
    [inlineButton("🇪🇺 EUR", "onboard:currency:eur")],
    [inlineButton("🇬🇧 GBP", "onboard:currency:gbp")],
    [inlineButton("🇯🇵 JPY", "onboard:currency:jpy")],
    [inlineButton("✏️ Other", "onboard:currency:other")],
  ]);

  await ctx.reply(
    "👋 Welcome to CryptoWatch! Let's get you set up.\n\nWhat currency would you like prices in?",
    { reply_markup: currencyKb },
  );
});

// Onboarding: currency via button
composer.callbackQuery(/^onboard:currency:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const val = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();

  if (val === "other") {
    ctx.session.step = "onboarding_currency";
    await ctx.editMessageText("Type a currency code (e.g., USD, EUR, GBP):");
    return;
  }

  const currency = val.toUpperCase();
  let profile = await store.getUser(userId);
  if (!profile) {
    profile = {
      userId,
      displayName: ctx.from?.first_name ?? "User",
      tzOffsetMin: 0,
      currency,
      cooldownMin: 30,
      onboarded: false,
      createdAt: defaultClock.nowMs(),
    };
  } else {
    profile.currency = currency;
  }
  await store.saveUser(profile);
  await askTimezone(ctx, currency);
});

// Onboarding: timezone via button
composer.callbackQuery(/^onboard:tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const val = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();

  if (val === "other") {
    ctx.session.step = "onboarding_tz";
    await ctx.editMessageText(
      "Type your UTC offset in minutes (e.g., 180 for UTC+3, -300 for UTC-5):",
    );
    return;
  }

  const tzOffsetMin = parseInt(val, 10);
  await finalizeOnboarding(ctx, userId, store, tzOffsetMin);
});

// Onboarding: free-form currency text
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "onboarding_currency") return next();
  const text = ctx.message.text.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) {
    await ctx.reply("Please enter a 3-letter currency code like USD, EUR, or GBP.");
    return;
  }
  const userId = ctx.from!.id;
  const store = getDomainStore();
  let profile = await store.getUser(userId);
  if (!profile) {
    profile = {
      userId,
      displayName: ctx.from?.first_name ?? "User",
      tzOffsetMin: 0,
      currency: text,
      cooldownMin: 30,
      onboarded: false,
      createdAt: defaultClock.nowMs(),
    };
  } else {
    profile.currency = text;
  }
  await store.saveUser(profile);
  await askTimezone(ctx, text);
});

// Onboarding: free-form timezone text
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "onboarding_tz") return next();
  const text = ctx.message.text.trim();
  const offset = parseInt(text, 10);
  if (isNaN(offset) || offset < -720 || offset > 840) {
    await ctx.reply("Please enter a valid UTC offset in minutes (-720 to 840).");
    return;
  }
  const userId = ctx.from!.id;
  const store = getDomainStore();
  await finalizeOnboarding(ctx, userId, store, offset);
});

// Quick-add coins from onboarding
composer.callbackQuery(/^onboard:quickadd:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.callbackQuery.data.split(":").pop()!;
  const userId = ctx.from!.id;
  const store = getDomainStore();

  const { tickerToCoinId } = await import("../price-feed.js");
  const info = tickerToCoinId(ticker);
  if (info) {
    const existing = await store.getWatchlistEntry(userId, ticker);
    if (!existing) {
      await store.upsertWatchlistEntry(userId, {
        ticker,
        coinName: info.name,
        coinId: info.id,
        enabled: true,
        thresholds: [],
        percents: [],
      });
    }
  }

  await ctx.editMessageText(
    `Added ${ticker.toUpperCase()} to your watchlist. Add more or tap the menu when ready.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Add BTC", "onboard:quickadd:BTC")],
        [inlineButton("Add ETH", "onboard:quickadd:ETH")],
        [inlineButton("Add TON", "onboard:quickadd:TON")],
        [inlineButton("✏️ Type a ticker", "onboard:typeticker")],
        [inlineButton("✅ Done — show menu", "menu:main")],
      ]),
    },
  );
});

// "Type a ticker" from onboarding
composer.callbackQuery("onboard:typeticker", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_ticker";
  await ctx.editMessageText("Enter a ticker symbol (e.g., SOL, DOGE, ADA):");
});

// Free-form ticker during onboarding
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_ticker") return next();
  const ticker = ctx.message.text.trim().toUpperCase();
  const { tickerToCoinId } = await import("../price-feed.js");
  const info = tickerToCoinId(ticker);
  if (!info) {
    await ctx.reply(`Unknown ticker "${ticker}". Try a well-known coin like SOL, DOGE, or ADA.`);
    return;
  }

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const existing = await store.getWatchlistEntry(userId, ticker);
  if (!existing) {
    await store.upsertWatchlistEntry(userId, {
      ticker,
      coinName: info.name,
      coinId: info.id,
      enabled: true,
      thresholds: [],
      percents: [],
    });
  }

  ctx.session.step = "idle";
  await ctx.reply(`✅ Added ${ticker} (${info.name}) to your watchlist.`, {
    reply_markup: inlineKeyboard([
      [inlineButton("Add more coins", "onboard:typeticker")],
      [inlineButton("✅ Done — show menu", "menu:main")],
    ]),
  });
});

// ---- Helpers ----

async function askTimezone(ctx: Ctx, currency: string) {
  ctx.session.step = "onboarding_tz";
  const tzKb = inlineKeyboard([
    [
      inlineButton("UTC-8 (PT)", "onboard:tz:-480"),
      inlineButton("UTC-5 (ET)", "onboard:tz:-300"),
      inlineButton("UTC+0 (UK)", "onboard:tz:0"),
    ],
    [
      inlineButton("UTC+1 (CET)", "onboard:tz:60"),
      inlineButton("UTC+3 (MSK)", "onboard:tz:180"),
      inlineButton("UTC+8 (CST)", "onboard:tz:480"),
    ],
    [
      inlineButton("UTC+5:30 (IST)", "onboard:tz:330"),
      inlineButton("UTC+9 (JST)", "onboard:tz:540"),
      inlineButton("✏️ Other", "onboard:tz:other"),
    ],
  ]);
  await ctx.editMessageText(
    `Got it, prices in ${currency.toUpperCase()}. What's your timezone?`,
    { reply_markup: tzKb },
  );
}

async function finalizeOnboarding(
  ctx: Ctx,
  userId: number,
  store: ReturnType<typeof getDomainStore>,
  tzOffsetMin: number,
) {
  let profile = await store.getUser(userId);
  if (!profile) {
    profile = {
      userId,
      displayName: ctx.from?.first_name ?? "User",
      tzOffsetMin,
      currency: "USD",
      cooldownMin: 30,
      onboarded: false,
      createdAt: defaultClock.nowMs(),
    };
  }
  profile.tzOffsetMin = tzOffsetMin;
  profile.onboarded = true;
  await store.saveUser(profile);

  ctx.session.step = "idle";

  await ctx.editMessageText(
    "✅ You're all set! Tap a coin below to add it to your watchlist, or type any ticker.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Add BTC", "onboard:quickadd:BTC")],
        [inlineButton("Add ETH", "onboard:quickadd:ETH")],
        [inlineButton("Add TON", "onboard:quickadd:TON")],
        [inlineButton("✏️ Type a ticker", "onboard:typeticker")],
        [inlineButton("✅ Done — show menu", "menu:main")],
      ]),
    },
  );
}

export default composer;