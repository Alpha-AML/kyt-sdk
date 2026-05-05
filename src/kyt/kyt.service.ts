import axios, { type AxiosInstance } from 'axios';
import type { AlphaAmlReport, SupportedChain } from '../types.js';
import { CHAIN_META } from '../config/chains.js';

const KYT_API_BASE = 'https://api-v2.alpha-aml.com';
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const MAX_CACHE_SIZE = 10_000;

interface CacheEntry {
  report: AlphaAmlReport;
  expiresAt: number;
}

export class KytService {
  private readonly http: AxiosInstance;
  private apiKey: string | null = null;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly getApiKey: () => Promise<string>) {
    this.http = axios.create({
      baseURL: KYT_API_BASE,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  /**
   * Fetches a risk report for the given address on the given chain.
   * Returns cached results for up to 5 minutes to respect Alpha AML rate limits.
   *
   * @throws If the API returns a non-2xx response or times out.
   */
  async check(address: string, chain: SupportedChain): Promise<AlphaAmlReport> {
    const cacheKey = `${chain}:${address.toLowerCase()}`;
    const cached   = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.report;

    const apiKey     = await this.resolveApiKey();
    const amlChainId = CHAIN_META[chain].amlChainId;

    const { data } = await this.http.get<AlphaAmlReport>('/api/report-v1', {
      params: { address, chain: amlChainId, apiKey },
    });

    // Runtime validation: ensure the score field is present and numeric
    if (
      typeof data?.risk_assessment?.score !== 'number' ||
      isNaN(data.risk_assessment.score)
    ) {
      throw new Error(
        `Alpha AML API returned malformed report for address "${address}" on "${chain}": missing or invalid risk_assessment.score`,
      );
    }

    // Evict expired entries when cache exceeds max size
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
    }

    this.cache.set(cacheKey, { report: data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  }

  /** Extract the numeric risk score from a report. */
  static extractScore(report: AlphaAmlReport): number {
    return report.risk_assessment.score;
  }

  /** Clears the in-memory cache (useful in tests). */
  clearCache(): void {
    this.cache.clear();
  }

  private async resolveApiKey(): Promise<string> {
    if (!this.apiKey) this.apiKey = await this.getApiKey();
    return this.apiKey;
  }
}
