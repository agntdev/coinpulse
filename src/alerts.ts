// Alert engine — checks watchlist entries against current prices, evaluates rules,
// respects quiet hours and cooldown, delivers alerts via Telegram, and records telemetry.

import type { Clock } from "./clock.js";
import { defaultClock } from "./clock.js";
import { toLocalHHMM, isInQuietHours, type AlertEvent, type UserProfile, type ThresholdRule, type PercentRule } from "./models.js";
import type { PriceFeed } from "./price-feed.js";
import type { DomainStore } from "./store.js";

export interface AlertEngine {
  /** Check all watchlist rules for all users. Returns alerts triggered. */
  checkAll(): Promise<AlertEvent[]>;
  /** Check a specific user's watchlist. Returns alerts triggered. */
  checkUser(userId: number): Promise<AlertEvent[]>;
  /** Check a specific ticker for a user. */
  checkTicker(userId: number, ticker: string): Promise<AlertEvent | null>;
}

export interface AlertEngineDeps {
  store: DomainStore;
  priceFeed: PriceFeed;
  clock: Clock;
  /** Deliver an alert message to a user. Returns true if delivered. */
  deliver: (userId: number, text: string) => Promise<boolean>;
}

export function createAlertEngine(deps: AlertEngineDeps): AlertEngine {
  async function checkUser(userId: number): Promise<AlertEvent[]> {
    const user = await deps.store.getUser(userId);
    if (!user || !user.onboarded) return [];

    const entries = await deps.store.getWatchlist(userId);
    if (entries.length === 0) return [];

    const activeEntries = entries.filter((e) => e.enabled);
    if (activeEntries.length === 0) return [];

    // Fetch all prices in batch
    const coinIds = activeEntries.map((e) => e.coinId);
    const prices = await deps.priceFeed.getPrices(coinIds);
    if (prices.size === 0) return []; // Feed failure

    const triggered: AlertEvent[] = [];
    const now = deps.clock.now();
    const nowMs = deps.clock.nowMs();
    const localHHMM = toLocalHHMM(now, user.tzOffsetMin);

    // Check quiet hours (skip all alerts if inside quiet hours)
    const inQuiet = user.quietStart && user.quietEnd
      ? isInQuietHours(localHHMM, user.quietStart, user.quietEnd)
      : false;

    for (const entry of activeEntries) {
      const snap = prices.get(entry.coinId);
      if (!snap) continue;

      const oldPrice = entry.lastAlertPrice ?? snap.currentPrice;

      // Check threshold rules
      for (const rule of entry.thresholds) {
        if (inQuiet) continue;
        if (!shouldFireThreshold(rule, oldPrice, snap.currentPrice, nowMs, user.cooldownMin)) continue;

        const direction = rule.direction === "above" ? "above" : "below";
        const event: AlertEvent = {
          userId,
          ticker: entry.ticker,
          ruleId: rule.id,
          ruleLabel: `threshold:${direction}:${rule.value}`,
          oldPrice,
          newPrice: snap.currentPrice,
          percentChange: snap.percentChange1h ?? 0,
          timestamp: nowMs,
          delivered: false,
        };

        // Mark cooldown
        rule.lastFiredAt = nowMs;
        entry.lastAlertAt = nowMs;
        entry.lastAlertPrice = snap.currentPrice;

        triggered.push(event);
      }

      // Check percentage rules
      const pc = snap.percentChange1h;
      if (pc != null) {
        for (const rule of entry.percents) {
          if (inQuiet) continue;
          if (!shouldFirePercent(rule, pc, nowMs, user.cooldownMin)) continue;

          const dirLabel = rule.direction === "both" ? `${Math.abs(pc).toFixed(1)}%` : `${rule.direction === "up" ? "+" : "-"}${Math.abs(pc).toFixed(1)}%`;
          const event: AlertEvent = {
            userId,
            ticker: entry.ticker,
            ruleId: rule.id,
            ruleLabel: `percent:${rule.direction}:${rule.percent}`,
            oldPrice,
            newPrice: snap.currentPrice,
            percentChange: pc,
            timestamp: nowMs,
            delivered: false,
          };

          rule.lastFiredAt = nowMs;
          entry.lastAlertAt = nowMs;
          entry.lastAlertPrice = snap.currentPrice;

          triggered.push(event);
        }
      }

      await deps.store.upsertWatchlistEntry(userId, entry);
    }

    // Deliver + persist each triggered alert
    const delivered: AlertEvent[] = [];
    for (const event of triggered) {
      const text = formatAlert(event);
      const ok = await deps.deliver(userId, text);
      event.delivered = ok;
      if (ok) {
        delivered.push(event);
        await deps.store.saveAlert(event);
        await deps.store.recordAlertTelemetry(event, deps.clock.nowMs());
      }
    }

    return delivered;
  }

  async function checkAll(): Promise<AlertEvent[]> {
    const ids = await deps.store.getAllUserIds();
    const all: AlertEvent[] = [];
    for (const id of ids) {
      // tolerate individual user failures (e.g. blocked bot)
      try {
        const alerts = await checkUser(id);
        all.push(...alerts);
      } catch {
        // skip this user silently
      }
    }
    return all;
  }

  async function checkTicker(userId: number, ticker: string): Promise<AlertEvent | null> {
    const entry = await deps.store.getWatchlistEntry(userId, ticker);
    if (!entry || !entry.enabled) return null;

    const user = await deps.store.getUser(userId);
    if (!user || !user.onboarded) return null;

    const snap = await deps.priceFeed.getPrice(entry.coinId);
    if (!snap) return null;

    const nowMs = deps.clock.nowMs();
    const now = deps.clock.now();
    const localHHMM = toLocalHHMM(now, user.tzOffsetMin);
    const inQuiet = user.quietStart && user.quietEnd
      ? isInQuietHours(localHHMM, user.quietStart, user.quietEnd)
      : false;

    const oldPrice = entry.lastAlertPrice ?? snap.currentPrice;

    for (const rule of entry.thresholds) {
      if (inQuiet) continue;
      if (!shouldFireThreshold(rule, oldPrice, snap.currentPrice, nowMs, user.cooldownMin)) continue;
      const direction = rule.direction === "above" ? "above" : "below";
      const event: AlertEvent = {
        userId, ticker: entry.ticker, ruleId: rule.id,
        ruleLabel: `threshold:${direction}:${rule.value}`,
        oldPrice, newPrice: snap.currentPrice,
        percentChange: snap.percentChange1h ?? 0,
        timestamp: nowMs, delivered: false,
      };
      rule.lastFiredAt = nowMs;
      entry.lastAlertAt = nowMs;
      entry.lastAlertPrice = snap.currentPrice;
      await deps.store.upsertWatchlistEntry(userId, entry);
      const text = formatAlert(event);
      const ok = await deps.deliver(userId, text);
      event.delivered = ok;
      if (ok) {
        await deps.store.saveAlert(event);
        await deps.store.recordAlertTelemetry(event, deps.clock.nowMs());
      }
      return ok ? event : null;
    }

    const pc = snap.percentChange1h;
    if (pc != null) {
      for (const rule of entry.percents) {
        if (inQuiet) continue;
        if (!shouldFirePercent(rule, pc, nowMs, user.cooldownMin)) continue;
        const event: AlertEvent = {
          userId, ticker: entry.ticker, ruleId: rule.id,
          ruleLabel: `percent:${rule.direction}:${rule.percent}`,
          oldPrice, newPrice: snap.currentPrice,
          percentChange: pc, timestamp: nowMs, delivered: false,
        };
        rule.lastFiredAt = nowMs;
        entry.lastAlertAt = nowMs;
        entry.lastAlertPrice = snap.currentPrice;
        await deps.store.upsertWatchlistEntry(userId, entry);
        const text = formatAlert(event);
        const ok = await deps.deliver(userId, text);
        event.delivered = ok;
        if (ok) {
          await deps.store.saveAlert(event);
          await deps.store.recordAlertTelemetry(event, deps.clock.nowMs());
        }
        return ok ? event : null;
      }
    }

    return null;
  }

  return { checkAll, checkUser, checkTicker };
}

// ---- Rule evaluation ----

function shouldFireThreshold(
  rule: ThresholdRule,
  oldPrice: number,
  newPrice: number,
  nowMs: number,
  cooldownMin: number,
): boolean {
  // Check cooldown
  if (rule.lastFiredAt) {
    const elapsed = nowMs - rule.lastFiredAt;
    if (elapsed < cooldownMin * 60_000) return false;
  }

  if (rule.direction === "above") {
    // Fire when price crosses above the threshold
    return oldPrice <= rule.value && newPrice > rule.value;
  } else {
    // Fire when price crosses below the threshold
    return oldPrice >= rule.value && newPrice < rule.value;
  }
}

function shouldFirePercent(
  rule: PercentRule,
  actualChange: number,
  nowMs: number,
  cooldownMin: number,
): boolean {
  if (rule.lastFiredAt) {
    const elapsed = nowMs - rule.lastFiredAt;
    if (elapsed < cooldownMin * 60_000) return false;
  }

  const absChange = Math.abs(actualChange);
  if (rule.direction === "up") return absChange >= rule.percent && actualChange > 0;
  if (rule.direction === "down") return absChange >= rule.percent && actualChange < 0;
  return absChange >= rule.percent; // both
}

// ---- Formatting ----

export function formatAlert(event: AlertEvent): string {
  const changePct = event.percentChange.toFixed(2);
  const sign = event.percentChange >= 0 ? "+" : "";
  const tickerLabel = event.ticker.toUpperCase();

  return `⚡ ${tickerLabel} alert\n` +
    `Price: $${event.newPrice.toFixed(2)} (${sign}${changePct}% 1h)\n` +
    `Rule: ${event.ruleLabel}`;
}

export function formatPriceLine(ticker: string, name: string, price: number, change1h: number | null): string {
  if (change1h != null) {
    const sign = change1h >= 0 ? "+" : "";
    return `${ticker} (${name}): $${price.toFixed(2)} (${sign}${change1h.toFixed(2)}% 1h)`;
  }
  return `${ticker} (${name}): $${price.toFixed(2)}`;
}