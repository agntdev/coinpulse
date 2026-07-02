import { Composer } from "grammy";
import { inlineKeyboard, inlineButton } from "../toolkit/index.js";
import type { Ctx } from "../bot.js";

// /help — explains the bot in plain language. Same content shown when tapping
// the Help button on the main menu. Button-first: guide users to tap /start.
// NOTE: mainMenuKeyboard() auto-appends a ❓ Help button — no need to register one.
const composer = new Composer<Ctx>();

const HELP =
  "ℹ️ Here's how CryptoWatch works:\n\n" +
  "• Add coins to your watchlist to track prices\n" +
  "• Set threshold alerts — get notified when a coin goes above or below a price\n" +
  "• Set percentage alerts — get notified when a coin moves by a certain %\n" +
  "• Check current prices anytime with /price or the Price check button\n" +
  "• Set quiet hours to silence alerts overnight\n\n" +
  "Examples:\n" +
  "Threshold: \"Alert me when BTC goes above $100,000\"\n" +
  "Percentage: \"Alert me when ETH moves 5% or more in 1 hour\"\n\n" +
  "Tap /start to open the menu and get started.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;