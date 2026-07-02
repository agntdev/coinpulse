import { Composer } from "grammy";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";

// Morning summary settings — set a time to receive daily price summaries, or disable.
const composer = new Composer<Ctx>();

registerMainMenuItem({ label: "📊 Summary", data: "summary:menu", order: 40 });

composer.callbackQuery("summary:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (!profile || !profile.onboarded) {
    await ctx.editMessageText("Please /start first to set up your profile.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "menu:main")]]),
    });
    return;
  }

  const current = profile.summaryTime
    ? `📊 Morning summary: ${profile.summaryTime}`
    : "📊 Morning summary is off";

  await ctx.editMessageText(
    `${current}\n\nSet a time to receive a daily summary of your watchlist prices.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🕐 07:00", "summary:set:07:00")],
        [inlineButton("🕐 08:00", "summary:set:08:00")],
        [inlineButton("🕐 09:00", "summary:set:09:00")],
        [inlineButton("🕐 10:00", "summary:set:10:00")],
        [inlineButton("✏️ Type a time", "summary:other")],
        [inlineButton("📊 Disable summary", "summary:disable")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

composer.callbackQuery(/^summary:set:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  const hh = parts[2];
  const mm = parts[3];
  const time = `${hh}:${mm}`;

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile) return;

  profile.summaryTime = time;
  await store.saveUser(profile);

  await ctx.editMessageText(
    `✅ Morning summary set for ${time}. You'll receive your watchlist prices daily.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "summary:menu")]]) },
  );
});

composer.callbackQuery("summary:other", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_summary_time";
  await ctx.editMessageText("Type a time in HH:MM format (e.g., 06:30):");
});

composer.callbackQuery("summary:disable", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile) return;

  profile.summaryTime = undefined;
  await store.saveUser(profile);

  await ctx.editMessageText(
    "📊 Morning summary disabled. You can re-enable it anytime.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "summary:menu")]]) },
  );
});

// Free-form summary time
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_summary_time") return next();
  const text = ctx.message.text.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) {
    await ctx.reply("Please enter a time in HH:MM format (e.g., 06:30).");
    return;
  }
  let hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    await ctx.reply("Invalid time. Please use HH:MM format (e.g., 06:30).");
    return;
  }

  const time = `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (profile) {
    profile.summaryTime = time;
    await store.saveUser(profile);
  }
  ctx.session.step = "idle";

  await ctx.reply(
    `✅ Morning summary set for ${time}. You'll receive your watchlist prices daily.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "summary:menu")]]) },
  );
});

// Support /summary command
composer.command("summary", async (ctx) => {
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile || !profile.onboarded) {
    await ctx.reply("Please /start first to set up your profile.");
    return;
  }

  const current = profile.summaryTime
    ? `📊 Morning summary: ${profile.summaryTime}`
    : "📊 Morning summary is off";

  await ctx.reply(
    `${current}\n\nTap the menu button to change your summary settings:`,
    { reply_markup: inlineKeyboard([[inlineButton("📊 Summary", "summary:menu")]]) },
  );
});

export default composer;