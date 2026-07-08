// Data types for CryptoWatch bot — persisted in the domain store.

/** A price-threshold rule: fire when price crosses `value` in `direction`. */
export interface ThresholdRule {
  id: string;
  direction: "above" | "below";
  value: number;
  lastFiredAt?: number; // unix ms — cooldown reference
}

/** A percentage-move rule: fire when price moves by `percent`% in `direction`. */
export interface PercentRule {
  id: string;
  direction: "up" | "down" | "both";
  percent: number;
  lastFiredAt?: number; // unix ms — cooldown reference
}

export interface WatchlistEntry {
  ticker: string;       // upper-case, e.g. "BTC"
  coinName: string;     // friendly name, e.g. "Bitcoin"
  coinId: string;       // CoinGecko id, e.g. "bitcoin"
  enabled: boolean;
  lastAlertAt?: number; // unix ms
  lastAlertPrice?: number;
  thresholds: ThresholdRule[];
  percents: PercentRule[];
  /** Per-coin AI override: true = force enable, false = force disable, undefined = use global. */
  aiOverride?: boolean;
}

export interface UserProfile {
  userId: number;
  displayName: string;
  /** Unix offset in minutes. E.g. UTC+3 → 180. */
  tzOffsetMin: number;
  currency: string;     // "usd", "eur", etc.
  quietStart?: string;  // "22:00" — HH:MM local
  quietEnd?: string;    // "08:00"
  cooldownMin: number;  // default 30
  summaryTime?: string; // "08:00" — HH:MM local, disabled if unset
  onboarded: boolean;
  createdAt: number;    // unix ms
  /** AI recommendation settings. */
  aiEnabled?: boolean;  // global opt-in for AI recs; default false
  /** Trading strategy — set when enabling AI. */
  strategy?: StrategyOption;
}

export type StrategyOption = "scalping" | "swing" | "position" | "custom";

export interface AlertEvent {
  userId: number;
  ticker: string;
  ruleId: string;
  ruleLabel: string;
  oldPrice: number;
  newPrice: number;
  percentChange: number;
  timestamp: number;    // unix ms
  delivered: boolean;
}

export interface OwnerTelemetry {
  totalUsers: number;
  tickerCounts: Record<string, number>; // ticker → total alerts fired
  ruleCounts: Record<string, number>;   // ruleType:d:p → count
  recentAlerts: AlertEvent[];           // capped at 100
  /** AI recommendation metrics. */
  aiUserCount: number;                  // users with AI enabled
  aiTopCoins: Record<string, number>;   // ticker → AI rec count
  aiRecommendationCounts: Record<string, number>; // BUY/SELL/HOLD → count
  recentRecommendations: AIRecommendationRecord[]; // capped at 50
}

/**
 * Record of an AI recommendation event, stored in telemetry.
 */
export interface AIRecommendationRecord {
  userId: number;
  ticker: string;
  timestamp: number;    // unix ms
  recommendation: string; // BUY | SELL | HOLD
  confidence: number;    // 0-100
}

/**
 * Response from the internal AI recommender service.
 */
export interface AIRecommendation {
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: number;       // 0–100
  rationale: string;        // short text, <=2 sentences
  suggestedTargetPrice?: number;
  suggestedTimeHorizon?: string;
}

// ---- Session (ephemeral conversation state) ----

export type FlowStep =
  | "idle"
  | "onboarding_currency"
  | "onboarding_tz"
  | "awaiting_ticker"
  | "choose_alert_type"
  | "threshold_direction"
  | "threshold_price"
  | "percent_direction"
  | "percent_value"
  | "confirm_alert"
  | "edit_rule"
  | "delete_confirm"
  | "awaiting_summary_time"
  // AI recommendation flow steps
  | "ai_strategy"
  | "ai_enable_prefs"
  | "ai_coin_override";

export interface Session {
  step: FlowStep;
  coin?: string;
  coinName?: string;
  coinId?: string;
  ruleType?: "threshold" | "percent";
  ruleDirection?: string;
  ruleValue?: number;
  editingRuleId?: string;
  editingTicker?: string;
  // AI recommendation fields
  aiTicker?: string;
  aiRecommendation?: AIRecommendation;
}

// ---- Cooldown / quiet-hours helpers ----

/** Check if the given time (HH:MM local) falls within quiet hours. */
export function isInQuietHours(
  nowLocalHHMM: string,
  startHHMM: string,
  endHHMM: string,
): boolean {
  // Supports overnight intervals e.g. 22:00 → 08:00
  if (startHHMM < endHHMM) {
    return nowLocalHHMM >= startHHMM && nowLocalHHMM < endHHMM;
  }
  // Wraps past midnight
  return nowLocalHHMM >= startHHMM || nowLocalHHMM < endHHMM;
}

/** Format a Date to "HH:MM" in the given timezone offset (minutes). */
export function toLocalHHMM(d: Date, tzOffsetMin: number): string {
  const local = new Date(d.getTime() + tzOffsetMin * 60_000);
  const hh = local.getUTCHours().toString().padStart(2, "0");
  const mm = local.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}