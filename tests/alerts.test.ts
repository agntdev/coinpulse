import { describe, it, expect, beforeEach } from "vitest";
import { createAlertEngine, formatAlert, formatPriceLine } from "../src/alerts.js";
import { DomainStore, InMemoryRedis } from "../src/store.js";
import type { PriceFeed, PriceSnapshot } from "../src/price-feed.js";
import type { Clock } from "../src/clock.js";
import type { UserProfile, WatchlistEntry, AlertEvent } from "../src/models.js";

/** A fake price feed that returns predetermined prices. */
class FakePriceFeed implements PriceFeed {
  private snapshots: Map<string, PriceSnapshot> = new Map();
  private fail = false;

  setPrice(coinId: string, price: number, change1h: number | null = null) {
    this.snapshots.set(coinId, {
      ticker: coinId.toUpperCase(),
      coinId,
      coinName: coinId,
      currentPrice: price,
      percentChange1h: change1h,
      lastUpdated: Date.now(),
    });
  }

  setFail(fail: boolean) { this.fail = fail; }

  async getPrice(coinId: string): Promise<PriceSnapshot | null> {
    if (this.fail) return null;
    return this.snapshots.get(coinId) ?? null;
  }

  async getPrices(coinIds: string[]): Promise<Map<string, PriceSnapshot>> {
    if (this.fail) return new Map();
    const m = new Map<string, PriceSnapshot>();
    for (const id of coinIds) {
      const s = this.snapshots.get(id);
      if (s) m.set(id, s);
    }
    return m;
  }
}

class FakeClock implements Clock {
  private _now = new Date("2024-01-15T12:00:00Z");
  now() { return this._now; }
  nowMs() { return this._now.getTime(); }
  advance(minutes: number) { this._now = new Date(this._now.getTime() + minutes * 60_000); }
  setTime(d: Date) { this._now = d; }
}

describe("AlertEngine", () => {
  let mem: InMemoryRedis;
  let store: DomainStore;
  let feed: FakePriceFeed;
  let clock: FakeClock;
  let delivered: { userId: number; text: string }[];
  let engine: ReturnType<typeof createAlertEngine>;

  const user: UserProfile = {
    userId: 1, displayName: "Test", tzOffsetMin: 0, currency: "USD",
    cooldownMin: 30, onboarded: true, createdAt: 1000,
  };

  const btcEntry: WatchlistEntry = {
    ticker: "BTC", coinName: "Bitcoin", coinId: "bitcoin",
    enabled: true, thresholds: [], percents: [],
  };

  beforeEach(async () => {
    mem = new InMemoryRedis();
    store = new DomainStore(mem);
    feed = new FakePriceFeed();
    clock = new FakeClock();
    delivered = [];

    await store.saveUser(user);
    await store.upsertWatchlistEntry(1, { ...btcEntry });

    feed.setPrice("bitcoin", 50000, 2.5);

    engine = createAlertEngine({
      store, priceFeed: feed, clock,
      deliver: async (userId, text) => {
        delivered.push({ userId, text });
        return true;
      },
    });
  });

  it("fires no alerts for a watchlist with no rules", async () => {
    const alerts = await engine.checkUser(1);
    expect(alerts).toEqual([]);
    expect(delivered.length).toBe(0);
  });

  it("fires a threshold alert when price crosses above", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "above", value: 49000 }];
    entry!.lastAlertPrice = 48000; // was below threshold
    await store.upsertWatchlistEntry(1, entry!);

    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1);
    expect(alerts[0].ticker).toBe("BTC");
    expect(alerts[0].ruleLabel).toBe("threshold:above:49000");
    expect(delivered.length).toBe(1);
    expect(delivered[0].text).toContain("BTC");
  });

  it("fires a threshold alert when price crosses below", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "below", value: 51000 }];
    entry!.lastAlertPrice = 52000; // was above threshold
    await store.upsertWatchlistEntry(1, entry!);

    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1);
  });

  it("does not fire threshold alert when condition not met", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "above", value: 100000 }];
    entry!.lastAlertPrice = 90000; // still below
    await store.upsertWatchlistEntry(1, entry!);

    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0);
  });

  it("respects cooldown period", async () => {
    // First check: price crosses above the threshold
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "above", value: 49000 }];
    entry!.lastAlertPrice = 48000; // was below
    await store.upsertWatchlistEntry(1, entry!);

    let alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1);
    expect(delivered.length).toBe(1);

    // Within cooldown: price drops below then rises again
    // Cooldown of 30 min means the next 30 min won't fire even if price recrosses
    feed.setPrice("bitcoin", 48000, -2);
    clock.advance(5);
    alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0); // no crossing above (price is 48000 < 49000)

    feed.setPrice("bitcoin", 51000, 4);
    alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0); // cooldown still active

    // Advance past 30 min cooldown AND set lastAlertPrice below threshold
    clock.advance(30); // total +35 min from first fire
    // Manually set the lastAlertPrice below threshold so the NEXT check sees a crossing
    const updatedEntry = await store.getWatchlistEntry(1, "BTC");
    updatedEntry!.lastAlertPrice = 48000;
    await store.upsertWatchlistEntry(1, updatedEntry!);

    alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1); // fires again
    expect(delivered.length).toBe(2);
  });

  it("respects quiet hours", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "above", value: 49000 }];
    entry!.lastAlertPrice = 48000;
    await store.upsertWatchlistEntry(1, entry!);

    user.quietStart = "22:00";
    user.quietEnd = "08:00";
    await store.saveUser(user);

    // 23:00 UTC → inside quiet hours (UTC+0)
    clock.setTime(new Date("2024-01-15T23:00:00Z"));
    let alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0);

    // 10:00 UTC → outside quiet hours
    clock.setTime(new Date("2024-01-16T10:00:00Z"));
    alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1);
  });

  it("does not fire when price feed fails", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "above", value: 49000 }];
    entry!.lastAlertPrice = 48000;
    await store.upsertWatchlistEntry(1, entry!);

    feed.setFail(true);
    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0);
  });

  it("skips disabled watchlist entries", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.thresholds = [{ id: "t1", direction: "above", value: 49000 }];
    entry!.lastAlertPrice = 48000;
    entry!.enabled = false;
    await store.upsertWatchlistEntry(1, entry!);

    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0);
  });

  it("fires percentage alerts based on 1h change", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.percents = [{ id: "p1", direction: "both", percent: 2 }];
    entry!.lastAlertPrice = 50000;
    await store.upsertWatchlistEntry(1, entry!);

    // feed has percentChange1h: 2.5, which meets 2% threshold
    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1);
  });

  it("does not fire percentage alert when change is below threshold", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.percents = [{ id: "p1", direction: "both", percent: 5 }];
    entry!.lastAlertPrice = 50000;
    await store.upsertWatchlistEntry(1, entry!);

    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0);
  });

  it("fires percentage alert for up direction only", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.percents = [{ id: "p1", direction: "up", percent: 2 }];
    entry!.lastAlertPrice = 50000;
    await store.upsertWatchlistEntry(1, entry!);

    // feed has percentChange1h: 2.5 (positive) → matches "up" direction
    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(1);
  });

  it("does not fire percentage alert for wrong direction", async () => {
    const entry = await store.getWatchlistEntry(1, "BTC");
    entry!.percents = [{ id: "p1", direction: "down", percent: 2 }];
    entry!.lastAlertPrice = 50000;
    await store.upsertWatchlistEntry(1, entry!);

    // feed has percentChange1h: 2.5 (positive, not negative) → doesn't match "down"
    const alerts = await engine.checkUser(1);
    expect(alerts.length).toBe(0);
  });
});

describe("formatAlert", () => {
  it("formats an alert event", () => {
    const event: AlertEvent = {
      userId: 1, ticker: "BTC", ruleId: "r1", ruleLabel: "threshold:above:50000",
      oldPrice: 49000, newPrice: 51000, percentChange: 4.08,
      timestamp: 1000, delivered: true,
    };
    const text = formatAlert(event);
    expect(text).toContain("BTC");
    expect(text).toContain("51000");
    expect(text).toContain("threshold:above:50000");
  });
});

describe("formatPriceLine", () => {
  it("formats with change", () => {
    const line = formatPriceLine("BTC", "Bitcoin", 50000, 2.5);
    expect(line).toContain("BTC");
    expect(line).toContain("Bitcoin");
    expect(line).toContain("50000");
    expect(line).toContain("+2.50%");
  });

  it("formats with negative change", () => {
    const line = formatPriceLine("BTC", "Bitcoin", 50000, -3.1);
    expect(line).toContain("-3.10%");
  });

  it("formats without change", () => {
    const line = formatPriceLine("ETH", "Ethereum", 3000, null);
    expect(line).toContain("ETH");
    expect(line).toContain("3000");
    expect(line).not.toContain("%");
  });
});