import { describe, it, expect } from "vitest";
import { tickerToCoinId, fuzzyMatchCoins } from "../src/price-feed.js";

describe("tickerToCoinId", () => {
  it("recognizes BTC", () => {
    const info = tickerToCoinId("BTC");
    expect(info).not.toBeNull();
    expect(info!.id).toBe("bitcoin");
    expect(info!.name).toBe("Bitcoin");
  });

  it("recognizes ETH", () => {
    const info = tickerToCoinId("ETH");
    expect(info).not.toBeNull();
    expect(info!.id).toBe("ethereum");
  });

  it("recognizes TON", () => {
    const info = tickerToCoinId("TON");
    expect(info).not.toBeNull();
    expect(info!.id).toBe("the-open-network");
  });

  it("is case-insensitive", () => {
    expect(tickerToCoinId("btc")).not.toBeNull();
    expect(tickerToCoinId("Btc")).not.toBeNull();
  });

  it("returns null for unknown ticker", () => {
    expect(tickerToCoinId("XYZ")).toBeNull();
    expect(tickerToCoinId("FAKE123")).toBeNull();
  });
});

describe("fuzzyMatchCoins", () => {
  it("matches by ticker prefix", () => {
    const matches = fuzzyMatchCoins("DO");
    expect(matches).toContain("DOGE");
  });

  it("matches by name substring", () => {
    const matches = fuzzyMatchCoins("chain");
    expect(matches).toContain("LINK");
  });

  it("returns up to 5 results", () => {
    const matches = fuzzyMatchCoins("A");
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it("returns empty for no match", () => {
    const matches = fuzzyMatchCoins("ZZZZ");
    expect(matches.length).toBe(0);
  });
});

describe("InMemoryRedis", () => {
  it("works as a basic key-value store", async () => {
    const { InMemoryRedis } = await import("../src/store.js");
    const r = new InMemoryRedis();

    await r.set("key1", "value1");
    expect(await r.get("key1")).toBe("value1");
    expect(await r.get("missing")).toBeNull();

    await r.del("key1");
    expect(await r.get("key1")).toBeNull();
  });

  it("supports set operations", async () => {
    const { InMemoryRedis } = await import("../src/store.js");
    const r = new InMemoryRedis();

    await r.sadd("set1", "a");
    await r.sadd("set1", "b");
    await r.sadd("set1", "a"); // duplicate

    const members = await r.smembers("set1");
    expect(members.sort()).toEqual(["a", "b"]);

    await r.srem("set1", "a");
    const after = await r.smembers("set1");
    expect(after).toEqual(["b"]);
  });

  it("resets cleanly", async () => {
    const { InMemoryRedis } = await import("../src/store.js");
    const r = new InMemoryRedis();
    await r.set("k", "v");
    await r.sadd("s", "m");
    r.reset();
    expect(await r.get("k")).toBeNull();
    expect(await r.smembers("s")).toEqual([]);
  });
});