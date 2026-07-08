// AI recommender service — calls an internal model endpoint for BUY/SELL/HOLD
// recommendations. Designed to be mocked or stubbed in tests.

import type { AIRecommendation, StrategyOption } from "./models.js";
import { defaultClock, type Clock } from "./clock.js";

/**
 * Input to the AI recommender service.
 */
export interface AIRecommendationInput {
  ticker: string;
  coinName: string;
  currentPrice: number;
  /** Recent percent changes. */
  percentChange1h: number | null;
  percentChange24h?: number | null;
  percentChange7d?: number | null;
  percentChange30d?: number | null;
  volume?: number | null;
  marketCap?: number | null;
  /** User's chosen strategy. */
  strategy: StrategyOption;
  /** The watchlist rule that triggered this recommendation (if from an alert). */
  triggeredRule?: string;
}

export interface Recommender {
  /**
   * Get a recommendation for a coin. Returns null on failure (after retries).
   * Must be rate-limited by the caller.
   */
  recommend(input: AIRecommendationInput): Promise<AIRecommendation | null>;
}

// ---------------------------------------------------------------------------
// Internal model endpoint client
// ---------------------------------------------------------------------------

const MODEL_ENDPOINT = process.env.AI_RECOMMENDER_URL ?? "http://localhost:8080/v1/recommend";
const MODEL_API_KEY = process.env.AI_RECOMMENDER_KEY ?? "";

/**
 * Default recommender that calls an internal model endpoint.
 * Falls back to a rule-based fallback if the endpoint is unreachable.
 */
export function createDefaultRecommender(clock?: Clock): Recommender {
  const _clock = clock ?? defaultClock;

  return {
    async recommend(input: AIRecommendationInput): Promise<AIRecommendation | null> {
      // Try the model endpoint first
      try {
        const body = {
          ticker: input.ticker,
          current_price: input.currentPrice,
          change_1h: input.percentChange1h,
          change_24h: input.percentChange24h,
          change_7d: input.percentChange7d,
          change_30d: input.percentChange30d,
          volume: input.volume,
          market_cap: input.marketCap,
          strategy: input.strategy,
          triggered_rule: input.triggeredRule,
          timestamp: _clock.nowMs(),
        };

        const resp = await fetch(MODEL_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(MODEL_API_KEY ? { Authorization: `Bearer ${MODEL_API_KEY}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });

        if (resp.ok) {
          const data = await resp.json() as AIRecommendation;
          return validateRecommendation(data);
        }
      } catch {
        // Fall through to fallback
      }

      // Fallback for when the model endpoint is unreachable: use a simple heuristic.
      return fallbackRecommendation(input, _clock);
    },
  };
}

function validateRecommendation(data: AIRecommendation): AIRecommendation | null {
  if (!data.recommendation || !["BUY", "SELL", "HOLD"].includes(data.recommendation)) return null;
  if (typeof data.confidence !== "number" || data.confidence < 0 || data.confidence > 100) return null;
  if (!data.rationale || data.rationale.length < 1) return null;
  return {
    recommendation: data.recommendation as "BUY" | "SELL" | "HOLD",
    confidence: Math.round(data.confidence),
    rationale: data.rationale.slice(0, 500),
    suggestedTargetPrice: data.suggestedTargetPrice,
    suggestedTimeHorizon: data.suggestedTimeHorizon,
  };
}

/**
 * Simple rule-based fallback recommendation for when the model endpoint is down.
 * Only used so the bot still works offline during development/testing.
 */
function fallbackRecommendation(input: AIRecommendationInput, clock: Clock): AIRecommendation {
  const pc1h = input.percentChange1h ?? 0;
  const absPc = Math.abs(pc1h);

  // Very basic momentum-based fallback
  let recommendation: "BUY" | "SELL" | "HOLD";
  let confidence: number;
  let rationale: string;
  let targetPrice: number | undefined;
  let horizon: string | undefined;

  if (pc1h > 5) {
    recommendation = "SELL";
    confidence = 55;
    rationale = "Strong upward momentum in the last hour suggests potential overbought conditions.";
    targetPrice = input.currentPrice * (1 - 0.02);
    horizon = "24h";
  } else if (pc1h < -5) {
    recommendation = "BUY";
    confidence = 55;
    rationale = "Significant dip detected — may present a buying opportunity if fundamentals are sound.";
    targetPrice = input.currentPrice * (1 + 0.03);
    horizon = "48h";
  } else {
    recommendation = "HOLD";
    confidence = absPc < 1 ? 70 : 50;
    rationale = "No significant short-term movement detected. Monitoring current position.";
  }

  return {
    recommendation,
    confidence,
    rationale,
    suggestedTargetPrice: targetPrice,
    suggestedTimeHorizon: horizon,
  };
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Simple sliding-window rate limiter for AI model calls.
 * Enforces max N calls per windowMs per user or globally.
 */
export class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();

  constructor(
    private maxCalls: number = 10,
    private windowMs: number = 60_000,
  ) {}

  /** Check and consume one token for `key`. Returns true if allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let entries = this.timestamps.get(key) ?? [];
    entries = entries.filter((t) => t > cutoff);
    if (entries.length >= this.maxCalls) {
      this.timestamps.set(key, entries);
      return false;
    }
    entries.push(now);
    this.timestamps.set(key, entries);
    return true;
  }

  /** Reset for test isolation. */
  reset(): void {
    this.timestamps.clear();
  }
}

/** Global rate limiter: max 10 calls per minute per user. */
export const defaultRateLimiter = new RateLimiter(10, 60_000);
