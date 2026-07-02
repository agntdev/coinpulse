import { describe, it, expect } from "vitest";
import { isInQuietHours, toLocalHHMM } from "../src/models.js";

describe("isInQuietHours", () => {
  it("returns true when current time is within quiet hours (overnight)", () => {
    expect(isInQuietHours("23:00", "22:00", "08:00")).toBe(true);
    expect(isInQuietHours("02:00", "22:00", "08:00")).toBe(true);
    expect(isInQuietHours("07:59", "22:00", "08:00")).toBe(true);
  });

  it("returns false when current time is outside quiet hours (overnight)", () => {
    expect(isInQuietHours("08:00", "22:00", "08:00")).toBe(false);
    expect(isInQuietHours("12:00", "22:00", "08:00")).toBe(false);
    expect(isInQuietHours("21:59", "22:00", "08:00")).toBe(false);
  });

  it("returns true within same-day quiet hours", () => {
    expect(isInQuietHours("09:00", "09:00", "17:00")).toBe(true);
    expect(isInQuietHours("12:00", "09:00", "17:00")).toBe(true);
    expect(isInQuietHours("16:59", "09:00", "17:00")).toBe(true);
  });

  it("returns false outside same-day quiet hours", () => {
    expect(isInQuietHours("08:59", "09:00", "17:00")).toBe(false);
    expect(isInQuietHours("17:00", "09:00", "17:00")).toBe(false);
  });

  it("handles edge cases at the boundary", () => {
    expect(isInQuietHours("00:00", "00:00", "06:00")).toBe(true);
    expect(isInQuietHours("06:00", "00:00", "06:00")).toBe(false);
  });
});

describe("toLocalHHMM", () => {
  it("converts UTC date to local HH:MM with positive offset", () => {
    // UTC 2024-01-15 10:30:00 + UTC+3 (180 min) = 13:30 local
    const d = new Date("2024-01-15T10:30:00Z");
    expect(toLocalHHMM(d, 180)).toBe("13:30");
  });

  it("converts UTC date to local HH:MM with negative offset", () => {
    // UTC 2024-01-15 10:30:00 + UTC-5 (-300 min) = 05:30 local
    const d = new Date("2024-01-15T10:30:00Z");
    expect(toLocalHHMM(d, -300)).toBe("05:30");
  });

  it("wraps past midnight with positive offset", () => {
    // UTC 2024-01-15 23:00:00 + UTC+3 (180 min) = 02:00 next day
    const d = new Date("2024-01-15T23:00:00Z");
    expect(toLocalHHMM(d, 180)).toBe("02:00");
  });

  it("wraps to previous day with negative offset", () => {
    // UTC 2024-01-15 01:00:00 + UTC-5 (-300 min) = 20:00 previous day
    const d = new Date("2024-01-15T01:00:00Z");
    expect(toLocalHHMM(d, -300)).toBe("20:00");
  });
});