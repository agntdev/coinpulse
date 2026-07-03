// Scheduler — periodic alert checking and morning summary delivery.
// Runs in the main process (started from index.ts). Checks alerts every 5 minutes,
// and delivers morning summaries at each user's configured time.

import { getDomainStore } from "./store.js";
import { defaultPriceFeed } from "./price-feed.js";
import { defaultClock } from "./clock.js";
import { createAlertEngine, formatPriceLine } from "./alerts.js";
import { toLocalHHMM } from "./models.js";
import type { Bot } from "grammy";
import type { BotContext } from "./bot.js";
import type { Session } from "./bot.js";

export function startScheduler(bot: Bot<BotContext<Session>>): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const deliver = createDeliver(bot);

  // Run every 5 minutes
  async function tick() {
    if (stopped) return;
    try {
      await checkAlerts(deliver);
      await checkSummaries(bot);
    } catch {
      // Scheduler errors are non-fatal
    }
  }

  // Immediate first check, then every 5 minutes
  tick();
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

async function checkAlerts(deliver: (userId: number, text: string) => Promise<boolean>): Promise<void> {
  const store = getDomainStore();
  const feed = await defaultPriceFeed();
  const clock = defaultClock;

  const engine = createAlertEngine({
    store,
    priceFeed: feed,
    clock,
    deliver,
  });

  await engine.checkAll();
}

/** Build a bot-aware deliver function that sends a DM and tolerates 403. */
export function createDeliver(bot: Bot<BotContext<Session>>) {
  return async (userId: number, text: string): Promise<boolean> => {
    try {
      await bot.api.sendMessage(userId, text);
      return true;
    } catch (err: any) {
      // 403: user blocked or hasn't started the bot — skip silently
      if (err?.error_code === 403) return false;
      // Other errors: log but don't crash
      console.error(`[deliver] failed for user ${userId}:`, err?.description ?? err);
      return false;
    }
  };
}

async function checkSummaries(bot: Bot<BotContext<Session>>): Promise<void> {
  const store = getDomainStore();
  const feed = await defaultPriceFeed();
  const clock = defaultClock;
  const now = clock.now();
  const userIds = await store.getAllUserIds();

  for (const userId of userIds) {
    try {
      const profile = await store.getUser(userId);
      if (!profile || !profile.summaryTime) continue;

      // Check if current local time matches the summary time (within 5 min window)
      const localHHMM = toLocalHHMM(now, profile.tzOffsetMin);
      if (localHHMM !== profile.summaryTime) continue;

      const entries = await store.getWatchlist(userId);
      if (entries.length === 0) continue;

      const coinIds = entries.map((e) => e.coinId);
      const prices = await feed.getPrices(coinIds);
      if (prices.size === 0) continue;

      const lines: string[] = ["📊 Morning summary:"];
      for (const entry of entries) {
        const snap = prices.get(entry.coinId);
        if (snap) {
          lines.push(formatPriceLine(snap.ticker, snap.coinName, snap.currentPrice, snap.percentChange1h));
        } else {
          lines.push(`${entry.ticker}: price unavailable`);
        }
      }

      const text = lines.join("\n");
      try {
        await bot.api.sendMessage(userId, text);
      } catch (err: any) {
        if (err?.error_code !== 403) {
          console.error(`[summary] failed for user ${userId}:`, err?.description ?? err);
        }
      }
    } catch {
      // skip individual user failures
    }
  }
}