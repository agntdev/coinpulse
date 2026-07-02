import { Composer } from "grammy";
import type { Ctx } from "../bot.js";

// /cancel — cancel any multi-step flow and reset to idle.
const composer = new Composer<Ctx>();

composer.command("cancel", async (ctx) => {
  ctx.session.step = "idle";
  ctx.session.coin = undefined;
  ctx.session.ruleType = undefined;
  ctx.session.ruleDirection = undefined;
  ctx.session.ruleValue = undefined;
  ctx.session.coinName = undefined;
  ctx.session.coinId = undefined;
  ctx.session.editingRuleId = undefined;
  ctx.session.editingTicker = undefined;
  await ctx.reply("Cancelled. Tap /start to open the menu.");
});

export default composer;