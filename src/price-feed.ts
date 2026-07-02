// Price feed — fetches current crypto prices from the CoinGecko API.
// Uses real HTTP calls (not faked) with retries and quiet failure handling.

/**
 * Per-coin price snapshot returned by the feed.
 */
export interface PriceSnapshot {
  ticker: string;
  coinId: string;
  coinName: string;
  currentPrice: number;
  percentChange1h: number | null;
  lastUpdated: number; // unix ms
}

export interface PriceFeed {
  /** Fetch a single coin price. Returns null on failure (after retries). */
  getPrice(coinId: string): Promise<PriceSnapshot | null>;
  /** Fetch prices for multiple coins. Batch-resolves in one API call. */
  getPrices(coinIds: string[]): Promise<Map<string, PriceSnapshot>>;
}

// Known ticker → CoinGecko id + name mapping
const KNOWN_COINS: Record<string, { id: string; name: string }> = {
  BTC: { id: "bitcoin", name: "Bitcoin" },
  ETH: { id: "ethereum", name: "Ethereum" },
  TON: { id: "the-open-network", name: "Toncoin" },
  SOL: { id: "solana", name: "Solana" },
  XRP: { id: "ripple", name: "XRP" },
  ADA: { id: "cardano", name: "Cardano" },
  DOGE: { id: "dogecoin", name: "Dogecoin" },
  DOT: { id: "polkadot", name: "Polkadot" },
  AVAX: { id: "avalanche-2", name: "Avalanche" },
  MATIC: { id: "matic-network", name: "Polygon" },
  LINK: { id: "chainlink", name: "Chainlink" },
  UNI: { id: "uniswap", name: "Uniswap" },
  ATOM: { id: "cosmos", name: "Cosmos" },
  LTC: { id: "litecoin", name: "Litecoin" },
  BCH: { id: "bitcoin-cash", name: "Bitcoin Cash" },
  TRX: { id: "tron", name: "TRON" },
  USDT: { id: "tether", name: "Tether" },
  USDC: { id: "usd-coin", name: "USD Coin" },
  DAI: { id: "dai", name: "Dai" },
  SHIB: { id: "shiba-inu", name: "Shiba Inu" },
};

const CG_BASE = "https://api.coingecko.com/api/v3";

/** Resolve a ticker (upper-case) to CoinGecko id, or null. */
export function tickerToCoinId(ticker: string): { id: string; name: string } | null {
  const upper = ticker.toUpperCase();
  return KNOWN_COINS[upper] ?? null;
}

/** Fuzzy-match a partial ticker string against known coins. Returns up to 5 matches. */
export function fuzzyMatchCoins(partial: string): string[] {
  const upper = partial.toUpperCase();
  const results: string[] = [];
  for (const ticker of Object.keys(KNOWN_COINS)) {
    if (ticker.startsWith(upper) || KNOWN_COINS[ticker].name.toUpperCase().includes(upper)) {
      results.push(ticker);
    }
    if (results.length >= 5) break;
  }
  return results;
}

/**
 * Default price feed using CoinGecko free API.
 * - Retries on 429 / 5xx up to 3 times with backoff.
 * - Returns null on persistent failure (no alert delivery).
 */
export async function defaultPriceFeed(): Promise<PriceFeed> {
  return {
    async getPrice(coinId: string): Promise<PriceSnapshot | null> {
      const prices = await fetchPrices([coinId]);
      return prices.get(coinId) ?? null;
    },

    async getPrices(coinIds: string[]): Promise<Map<string, PriceSnapshot>> {
      return fetchPrices(coinIds);
    },
  };
}

async function fetchPrices(coinIds: string[]): Promise<Map<string, PriceSnapshot>> {
  if (coinIds.length === 0) return new Map();

  // Build reverse map: coinId → ticker
  const idToTicker: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  for (const [ticker, info] of Object.entries(KNOWN_COINS)) {
    idToTicker[info.id] = ticker;
    idToName[info.id] = info.name;
  }

  // CoinGecko supports up to ~250 ids per request; chunk if needed
  const chunkSize = 100;
  const results = new Map<string, PriceSnapshot>();

  for (let i = 0; i < coinIds.length; i += chunkSize) {
    const chunk = coinIds.slice(i, i + chunkSize);
    const idsParam = chunk.join(",");
    const url = `${CG_BASE}/simple/price?ids=${idsParam}&vs_currencies=usd&include_1hr_change=true`;

    const data = await fetchWithRetry(url);
    if (!data) continue; // chunk failed — skip silently

    for (const id of chunk) {
      const entry = data[id];
      if (!entry || entry.usd == null) continue;

      const ticker = idToTicker[id] ?? id.toUpperCase();
      const name = idToName[id] ?? id;

      results.set(id, {
        ticker,
        coinId: id,
        coinName: name,
        currentPrice: entry.usd,
        percentChange1h: entry.usd_1h_change ?? null,
        lastUpdated: Date.now(),
      });
    }
  }

  return results;
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (resp.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "2", 10);
        await sleep(Math.min(retryAfter * 1000, 5000));
        continue;
      }

      if (!resp.ok && resp.status >= 500) {
        // Server error — retry
        if (attempt < maxRetries) {
          await sleep((attempt + 1) * 1000);
          continue;
        }
        return null;
      }

      if (!resp.ok) return null;

      return await resp.json();
    } catch {
      // Network error — retry
      if (attempt < maxRetries) {
        await sleep((attempt + 1) * 1000);
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}