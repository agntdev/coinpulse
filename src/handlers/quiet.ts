import { Composer } from "grammy";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import type { Ctx } from "../bot.js";
import { getDomainStore } from "../store.js";

// Quiet hours — set or disable quiet hours (alerts suppressed during this window).
const composer = new Composer<Ctx>();

registerMainMenuItem({ label: "🔇 Quiet hours", data: "quiet:menu", order: 30 });

composer.callbackQuery("quiet:menu", async (ctx) => {
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

  const current = profile.quietStart && profile.quietEnd
    ? `🔇 Quiet hours: ${profile.quietStart} — ${profile.quietEnd}`
    : "🔇 Quiet hours are off";

  await ctx.editMessageText(
    `${current}\n\nSet a time range when alerts should be silenced (your local time).\nExample: 22:00 to 08:00`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🕐 22:00 – 08:00 (night)", "quiet:set:22:00:08:00")],
        [inlineButton("🕐 23:00 – 07:00", "quiet:set:23:00:07:00")],
        [inlineButton("🕐 21:00 – 06:00", "quiet:set:21:00:06:00")],
        [inlineButton("🔇 Disable quiet hours", "quiet:disable")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

composer.callbackQuery(/^quiet:set:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  const start = `${parts[2]}:${parts[3]}`;
  const end = `${parts[4]}:${parts[5]}`;

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile) return;

  profile.quietStart = start;
  profile.quietEnd = end;
  await store.saveUser(profile);

  await ctx.editMessageText(
    `✅ Quiet hours set: ${start} — ${end}. Alerts will be silenced during this window.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "quiet:menu")]]) },
  );
});

composer.callbackQuery("quiet:disable", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile) return;

  profile.quietStart = undefined;
  profile.quietEnd = undefined;
  await store.saveUser(profile);

  await ctx.editMessageText(
    "🔇 Quiet hours disabled. You'll receive all alerts round the clock.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "quiet:menu")]]) },
  );
});

// Also support /quiet command
composer.command("quiet", async (ctx) => {
  // Redirect to the menu equivalent
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (!profile || !profile.onboarded) {
    await ctx.reply("Please /start first to set up your profile.");
    return;
  }
  const current = profile.quietStart && profile.quietEnd
    ? `🔇 Quiet hours: ${profile.quietStart} — ${profile.quietEnd}`
    : "🔇 Quiet hours are off";

  await ctx.reply(
    `${current}\n\nTap the menu button to change your quiet hours:`,
    { reply_markup: inlineKeyboard([[inlineButton("🔇 Quiet hours", "quiet:menu")]]) },
  );
});

export default composer;