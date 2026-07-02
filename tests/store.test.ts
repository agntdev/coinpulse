import { describe, it, expect, beforeEach } from "vitest";
import { DomainStore, InMemoryRedis } from "../src/store.js";
import type { UserProfile, WatchlistEntry, AlertEvent } from "../src/models.js";

describe("DomainStore (InMemoryRedis)", () => {
  let mem: InMemoryRedis;
  let store: DomainStore;

  beforeEach(() => {
    mem = new InMemoryRedis();
    store = new DomainStore(mem);
  });

  it("saves and retrieves a user profile", async () => {
    const profile: UserProfile = {
      userId: 1,
      displayName: "Test",
      tzOffsetMin: 0,
      currency: "USD",
      cooldownMin: 30,
      onboarded: true,
      createdAt: 1000,
    };
    await store.saveUser(profile);
    const got = await store.getUser(1);
    expect(got).toEqual(profile);
  });

  it("returns null for unknown user", async () => {
    const got = await store.getUser(999);
    expect(got).toBeNull();
  });

  it("counts users correctly", async () => {
    expect(await store.countUsers()).toBe(0);
    await store.saveUser({ userId: 1, displayName: "A", tzOffsetMin: 0, currency: "USD", cooldownMin: 30, onboarded: true, createdAt: 1000 });
    await store.saveUser({ userId: 2, displayName: "B", tzOffsetMin: 0, currency: "USD", cooldownMin: 30, onboarded: true, createdAt: 1001 });
    expect(await store.countUsers()).toBe(2);
  });

  it("manages watchlist entries", async () => {
    const entry: WatchlistEntry = {
      ticker: "BTC", coinName: "Bitcoin", coinId: "bitcoin",
      enabled: true, thresholds: [], percents: [],
    };
    await store.upsertWatchlistEntry(1, entry);
    const got = await store.getWatchlistEntry(1, "BTC");
    expect(got).toEqual(entry);

    // Update existing
    entry.enabled = false;
    await store.upsertWatchlistEntry(1, entry);
    const updated = await store.getWatchlistEntry(1, "BTC");
    expect(updated?.enabled).toBe(false);

    // Get tickers via index
    const tickers = await store.getWatchlistTickers(1);
    expect(tickers).toEqual(["BTC"]);

    // Remove
    await store.removeWatchlistEntry(1, "BTC");
    expect(await store.getWatchlistEntry(1, "BTC")).toBeNull();
    expect(await store.getWatchlist(1)).toEqual([]);
  });

  it("saves and retrieves alert events", async () => {
    const alert: AlertEvent = {
      userId: 1, ticker: "BTC", ruleId: "r1", ruleLabel: "threshold:above:50000",
      oldPrice: 49000, newPrice: 51000, percentChange: 4.08,
      timestamp: 1000, delivered: true,
    };
    const id = await store.saveAlert(alert);
    expect(id).toBeTruthy();

    const recent = await store.getRecentAlerts(10);
    expect(recent.length).toBe(1);
    expect(recent[0].ticker).toBe("BTC");
  });

  it("retrieves recent alerts in reverse chronological order", async () => {
    const a1: AlertEvent = { userId: 1, ticker: "BTC", ruleId: "r1", ruleLabel: "t1", oldPrice: 49000, newPrice: 51000, percentChange: 4, timestamp: 1000, delivered: true };
    const a2: AlertEvent = { userId: 1, ticker: "ETH", ruleId: "r2", ruleLabel: "t2", oldPrice: 3000, newPrice: 3100, percentChange: 3.3, timestamp: 2000, delivered: true };
    await store.saveAlert(a1);
    await store.saveAlert(a2);
    const recent = await store.getRecentAlerts(10);
    expect(recent.length).toBe(2);
    expect(recent[0].ticker).toBe("ETH"); // most recent first
    expect(recent[1].ticker).toBe("BTC");
  });

  it("manages owner telemetry", async () => {
    const t = await store.getTelemetry();
    expect(t.totalUsers).toBe(0);
    expect(t.recentAlerts).toEqual([]);

    t.totalUsers = 5;
    await store.saveTelemetry(t);
    const got = await store.getTelemetry();
    expect(got.totalUsers).toBe(5);
  });

  it("records alert telemetry", async () => {
    const alert: AlertEvent = {
      userId: 1, ticker: "BTC", ruleId: "r1", ruleLabel: "threshold:above:50000",
      oldPrice: 49000, newPrice: 51000, percentChange: 4, timestamp: 1000, delivered: true,
    };
    await store.recordAlertTelemetry(alert);
    const t = await store.getTelemetry();
    expect(t.tickerCounts["BTC"]).toBe(1);
    expect(t.ruleCounts["threshold:above:50000"]).toBe(1);
    expect(t.recentAlerts.length).toBe(1);
    expect(t.recentAlerts[0].ticker).toBe("BTC");

    // Second alert increments counter
    await store.recordAlertTelemetry(alert);
    const t2 = await store.getTelemetry();
    expect(t2.tickerCounts["BTC"]).toBe(2);
  });

  it("caps recent alerts at 100", async () => {
    for (let i = 0; i < 150; i++) {
      await store.recordAlertTelemetry({
        userId: 1, ticker: "BTC", ruleId: `r${i}`, ruleLabel: "t",
        oldPrice: 49000, newPrice: 51000, percentChange: 4, timestamp: 1000 + i, delivered: true,
      });
    }
    const t = await store.getTelemetry();
    expect(t.recentAlerts.length).toBe(100);
  });
});