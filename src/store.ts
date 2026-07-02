import { createRequire } from "node:module";
import type { AlertEvent, OwnerTelemetry, UserProfile, WatchlistEntry } from "./models.js";

// =============================================================================
// Domain store — persistent storage for durable bot data.
//
// Auto-selects Redis when REDIS_URL is set (production), falling back to an
// in-memory Map (dev / test harness). Uses EXPLICIT INDEX records to avoid
// keyspace enumeration (KEYS / SCAN) — see "no keyspace scans" constraint.
// =============================================================================

/** Minimal Redis-like client interface. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Indexed domain store
// ---------------------------------------------------------------------------

/** Prefix constants for the key space. */
const P = {
  user: "cw:user:",
  watchlist: "cw:wl:",
  alert: "cw:alert:",
  telemetry: "cw:telemetry",
  idxUsers: "cw:idx:users",
  idxWatchlist: "cw:idx:wl:",
  idxAlerts: "cw:idx:alerts",
  seqAlert: "cw:seq:alert",
};

function userKey(userId: number): string {
  return `${P.user}${userId}`;
}
function watchlistKey(userId: number): string {
  return `${P.watchlist}${userId}`;
}
function alertKey(id: string): string {
  return `${P.alert}${id}`;
}
function wlIdxKey(userId: number): string {
  return `${P.idxWatchlist}${userId}`;
}

export class DomainStore {
  constructor(private r: RedisLike) {}

  // ---- User profile ----

  async getUser(userId: number): Promise<UserProfile | null> {
    const raw = await this.r.get(userKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  }

  async saveUser(profile: UserProfile): Promise<void> {
    const raw = JSON.stringify(profile);
    await this.r.set(userKey(profile.userId), raw);
    await this.r.sadd(P.idxUsers, String(profile.userId));
  }

  async getAllUserIds(): Promise<number[]> {
    const ids = await this.r.smembers(P.idxUsers);
    return ids.map(Number).filter((n) => !isNaN(n));
  }

  async countUsers(): Promise<number> {
    const ids = await this.r.smembers(P.idxUsers);
    return ids.length;
  }

  // ---- Watchlist ----

  async getWatchlist(userId: number): Promise<WatchlistEntry[]> {
    const raw = await this.r.get(watchlistKey(userId));
    if (!raw) return [];
    return JSON.parse(raw) as WatchlistEntry[];
  }

  async saveWatchlist(userId: number, entries: WatchlistEntry[]): Promise<void> {
    await this.r.set(watchlistKey(userId), JSON.stringify(entries));
    // Rebuild index
    await this.r.del(wlIdxKey(userId));
    for (const e of entries) {
      await this.r.sadd(wlIdxKey(userId), e.ticker);
    }
  }

  async getWatchlistTickers(userId: number): Promise<string[]> {
    return this.r.smembers(wlIdxKey(userId));
  }

  /** Add or update a single watchlist entry. */
  async upsertWatchlistEntry(userId: number, entry: WatchlistEntry): Promise<void> {
    const entries = await this.getWatchlist(userId);
    const idx = entries.findIndex((e) => e.ticker === entry.ticker);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    await this.saveWatchlist(userId, entries);
  }

  /** Remove a ticker from a user's watchlist. */
  async removeWatchlistEntry(userId: number, ticker: string): Promise<void> {
    const entries = await this.getWatchlist(userId);
    const filtered = entries.filter((e) => e.ticker !== ticker);
    await this.saveWatchlist(userId, filtered);
  }

  async getWatchlistEntry(userId: number, ticker: string): Promise<WatchlistEntry | null> {
    const entries = await this.getWatchlist(userId);
    return entries.find((e) => e.ticker === ticker) ?? null;
  }

  // ---- Alert events ----

  async saveAlert(alert: AlertEvent, seq?: number): Promise<string> {
    // sequence number for ordering
    const nextSeq = seq ?? (await this.nextAlertSeq());
    const id = `a:${nextSeq}`;
    await this.r.set(alertKey(id), JSON.stringify({ ...alert, id }));
    await this.r.sadd(P.idxAlerts, id);
    return id;
  }

  private async nextAlertSeq(): Promise<number> {
    const raw = await this.r.get(P.seqAlert);
    const next = (raw ? parseInt(raw, 10) : 0) + 1;
    await this.r.set(P.seqAlert, String(next));
    return next;
  }

  async getRecentAlerts(limit = 100): Promise<AlertEvent[]> {
    const ids = await this.r.smembers(P.idxAlerts);
    // Sort descending by the embedded seq number
    const sorted = ids.sort((a, b) => {
      const na = parseInt(a.split(":")[1], 10);
      const nb = parseInt(b.split(":")[1], 10);
      return nb - na;
    });
    const recent = sorted.slice(0, limit);
    const results: AlertEvent[] = [];
    for (const id of recent) {
      const raw = await this.r.get(alertKey(id));
      if (raw) results.push(JSON.parse(raw) as AlertEvent);
    }
    return results;
  }

  // ---- Owner telemetry ----

  async getTelemetry(): Promise<OwnerTelemetry> {
    const raw = await this.r.get(P.telemetry);
    if (!raw) {
      return { totalUsers: 0, tickerCounts: {}, ruleCounts: {}, recentAlerts: [] };
    }
    return JSON.parse(raw) as OwnerTelemetry;
  }

  async saveTelemetry(t: OwnerTelemetry): Promise<void> {
    await this.r.set(P.telemetry, JSON.stringify(t));
  }

  /** Record an alert-fired event in telemetry (counters + rolling log capped at 100). */
  async recordAlertTelemetry(alert: AlertEvent): Promise<void> {
    const t = await this.getTelemetry();
    t.tickerCounts[alert.ticker] = (t.tickerCounts[alert.ticker] ?? 0) + 1;
    t.ruleCounts[alert.ruleLabel] = (t.ruleCounts[alert.ruleLabel] ?? 0) + 1;
    t.recentAlerts.unshift(alert);
    if (t.recentAlerts.length > 100) t.recentAlerts = t.recentAlerts.slice(0, 100);
    await this.saveTelemetry(t);
  }

  /** Sync totalUsers from the user index. */
  async syncTelemetryUserCount(): Promise<void> {
    const t = await this.getTelemetry();
    t.totalUsers = await this.countUsers();
    await this.saveTelemetry(t);
  }
}

// ---------------------------------------------------------------------------
// In-memory Redis-like (for dev / test harness)
// ---------------------------------------------------------------------------

export class InMemoryRedis implements RedisLike {
  private map = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.map.delete(k);
      this.sets.delete(k);
    }
  }

  async sadd(key: string, member: string): Promise<void> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key)!.add(member);
  }

  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  /** Reset all state (for test isolation). */
  reset(): void {
    this.map.clear();
    this.sets.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _domainStoreInstance: DomainStore | null = null;

/**
 * Create or return the singleton domain store. In production (REDIS_URL set)
 * uses Redis; otherwise uses an in-memory store suitable for dev / testing.
 */
export function getDomainStore(redisUrl?: string): DomainStore {
  if (_domainStoreInstance) return _domainStoreInstance;

  if (redisUrl) {
    const require = createRequire(import.meta.url);
    const ioredis: any = require("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    const client = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    _domainStoreInstance = new DomainStore(client);
  } else {
    const mem = new InMemoryRedis();
    _domainStoreInstance = new DomainStore(mem);
  }
  return _domainStoreInstance;
}

/**
 * Reset the singleton. Used for test isolation — call between specs.
 */
export function resetDomainStore(): void {
  if (_domainStoreInstance) {
    const r = (_domainStoreInstance as unknown as { r: RedisLike }).r;
    if (r instanceof InMemoryRedis) r.reset();
  }
  _domainStoreInstance = null;
}

/**
 * Create a fresh domain store backed by an InMemoryRedis (for test isolation).
 */
export function createTestDomainStore(): { store: DomainStore; mem: InMemoryRedis } {
  const mem = new InMemoryRedis();
  const store = new DomainStore(mem);
  return { store, mem };
}