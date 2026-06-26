import crypto from 'crypto';
import type { SupportedChain } from '../../src/types.js';

// ----------------------------------------------------------
// Currency codes
//
// CoinsPaid encodes the network directly in the currency code.
// There is NO separate "network" parameter in API requests.
//
// Codes verified from: https://docs.ca.cryptoprocessing.com/api-reference/currency-codes.md
// Call GET /currencies/list with your credentials to get the full list for your account.
// ----------------------------------------------------------

// Currency codes verified against GET /currencies/list response from CoinsPaid API.
// Only include codes that actually appear in the CoinsPaid currency catalog.
export const COINSPAID_CURRENCY: Partial<Record<SupportedChain, Record<string, string>>> = {
  ethereum: {
    USDT:     'USDTE',    // Ethereum USDT (not 'USDT' — that code doesn't exist)
    USDC:     'USDC',     // Ethereum USDC
  },
  // CoinsPaid sandbox monitors Ethereum Sepolia testnet (recommended by CoinsPaid support).
  'ethereum-sepolia': {
    USDC:     'USDC',     // Ethereum Sepolia USDC (Circle faucet: https://faucet.circle.com) — deposit only in sandbox
    USDT:     'USDTE',    // Ethereum Sepolia USDT — supports both deposit and withdrawal in sandbox
  },
  arbitrum: {
    USDT:     'USDTA',    // Arbitrum USDT
    USDC:     'USDCA',    // Arbitrum USDC
    'USDC.e': 'USDCA',   // bridged USDC — same CoinsPaid code
  },
  // CoinsPaid sandbox monitors Arbitrum Sepolia testnet (confirmed by CoinsPaid support).
  // USDCA in sandbox = test USDC on Arbitrum Sepolia. Same currency code as mainnet.
  'arbitrum-sepolia': {
    USDC: 'USDCA',
  },
  base: {
    USDT:     'USDTBASE', // Base USDT (verify with your account — may not be enabled)
    USDC:     'USDCBASE', // Base USDC
  },
  bsc: {
    USDT:     'USDTB',    // BSC USDT
    // USDC on BSC is not available in the CoinsPaid catalog
  },
  tron: {
    USDT:     'USDTT',    // Tron USDT (not 'USDTTRC20')
    // USDC on Tron is not available in the CoinsPaid catalog
  },
};

/** Resolve CoinsPaid currency code for a given chain + token symbol.
 *  Returns undefined if the pair is not in the mapping. */
export function resolveCpCurrency(chain: SupportedChain, tokenSymbol: string): string | undefined {
  return (COINSPAID_CURRENCY as Record<string, Record<string, string>>)[chain]?.[tokenSymbol];
}

/** Reverse-resolve: given a CoinsPaid currency code, find the token symbol for a chain. */
export function reverseResolveCpCurrency(chain: SupportedChain, cpCurrency: string): string | undefined {
  const chainMap = (COINSPAID_CURRENCY as Record<string, Record<string, string>>)[chain];
  if (!chainMap) return undefined;
  return Object.keys(chainMap).find(sym => chainMap[sym] === cpCurrency);
}

// ----------------------------------------------------------
// Sender / receiver data types
// ----------------------------------------------------------

export interface CpSenderDataLegal {
  legal_name:               string;
  country_of_registration:  string;  // ISO alpha-3, e.g. "USA", "EST"
}

export interface CpSenderDataNatural {
  first_name:    string;
  last_name:     string;
  date_of_birth: string;  // YYYY-MM-DD
}

export type CpSenderType = 'natural' | 'legal';
export type CpSenderData = CpSenderDataLegal | CpSenderDataNatural;

export interface CpPartyInfo {
  senderType:        CpSenderType;
  senderData:        CpSenderData;
  endUserReference:  string;  // persistent internal customer/company ID
}

// ----------------------------------------------------------
// API response types
// ----------------------------------------------------------

export interface CoinsPaidAddress {
  id:                  number;
  currency:            string;
  address:             string;
  foreign_id:          string;
  end_user_reference:  string;
  tag:                 string | null;
}

export interface CoinsPaidWithdrawal {
  id:         number;
  foreign_id: string;
  type:       string;
  status:     string;
}

export interface CoinsPaidWebhookPayload {
  id:         number;
  type:       'deposit' | 'withdrawal';
  status:     string;   // 'confirmed' | 'pending' | 'cancelled'
  foreign_id?: string;  // present on withdrawal
  crypto_address?: {
    id:         number;
    address:    string;
    foreign_id: string;
  };
  currency_received: {
    currency: string;
    amount:   string;
    amount_minus_fee?: string;
  };
  transactions: Array<{
    id:       string;
    currency: string;
    tx:       string;
    amount:   string;
  }>;
}

export interface CoinsPaidCurrencyInfo {
  id:                          number;
  type:                        string;
  currency:                    string;
  minimum_amount:              string;
  minimum_withdrawal_amount:   string;
  deposit_confirmations?:      number;
  deposit_fee_percent:         string;
  withdrawal_fee_percent:      string;
  precision:                   number;
}

// ----------------------------------------------------------
// Client
// ----------------------------------------------------------

export class CoinsPaidClient {
  // Lazily loaded and cached — one API call per process lifetime
  private currencyCache: Map<string, CoinsPaidCurrencyInfo> | null = null;

  constructor(
    private readonly apiUrl:    string,
    private readonly apiKey:    string,
    private readonly apiSecret: string,
  ) {}

  /**
   * Create (or reuse) a deposit address for a given CoinsPaid currency code.
   * foreignId     — unique ID for this deposit address (e.g. walletId:currency)
   * party         — sender KYC data required by CoinsPaid compliance
   */
  async createAddress(
    cpCurrency:  string,
    foreignId:   string,
    party:       CpPartyInfo,
  ): Promise<CoinsPaidAddress> {
    const result = await this.post<CoinsPaidAddress>('/addresses/take', {
      currency:           cpCurrency,
      foreign_id:         foreignId,
      end_user_reference: party.endUserReference,
      sender_type:        party.senderType,
      sender_data:        party.senderData as unknown as Record<string, string>,
    } as Record<string, unknown>);
    console.log(`[COINSPAID] createAddress response:`, JSON.stringify(result));
    return result;
  }

  /**
   * Initiate a crypto withdrawal.
   * amount — human-readable string, e.g. "100.00"
   * For withdrawals to our own buffer wallet, use receiver_type "self" (no receiver_data needed).
   */
  async withdraw(
    cpCurrency:  string,
    address:     string,
    amount:      string,
    foreignId:   string,
    party:       CpPartyInfo,
  ): Promise<CoinsPaidWithdrawal> {
    return this.post<CoinsPaidWithdrawal>('/withdrawal/crypto', {
      currency:           cpCurrency,
      amount,
      address,
      foreign_id:         foreignId,
      end_user_reference: party.endUserReference,
      sender_type:        party.senderType,
      sender_data:        party.senderData as unknown as Record<string, string>,
      receiver_type:      'self',  // withdrawal goes to our own controlled wallet
    } as Record<string, unknown>);
  }

  /**
   * List all currencies enabled for this account.
   * Call this to verify a currency (e.g. USDCA) is active before sending deposits.
   */
  async listCurrencies(): Promise<CoinsPaidCurrencyInfo[]> {
    return this.post<CoinsPaidCurrencyInfo[]>('/currencies/list', {});
  }

  /** Returns the minimum deposit amount for a currency, or null if unknown. */
  async getMinimumDeposit(cpCurrency: string): Promise<number | null> {
    if (!this.currencyCache) {
      const list = await this.listCurrencies();
      this.currencyCache = new Map(list.map(c => [c.currency, c]));
    }
    const info = this.currencyCache.get(cpCurrency);
    return info ? parseFloat(info.minimum_amount) : null;
  }

  /** Returns the minimum withdrawal amount for a currency, or null if unknown. */
  async getMinimumWithdrawal(cpCurrency: string): Promise<number | null> {
    if (!this.currencyCache) {
      const list = await this.listCurrencies();
      this.currencyCache = new Map(list.map(c => [c.currency, c]));
    }
    const info = this.currencyCache.get(cpCurrency);
    return info ? parseFloat(info.minimum_withdrawal_amount) : null;
  }

  /**
   * Verify an incoming CoinsPaid webhook signature.
   * CoinsPaid signs the raw request body with HMAC-SHA512 using the API secret.
   */
  verifyWebhook(rawBody: string, signature: string): boolean {
    const expected = crypto
      .createHmac('sha512', this.apiSecret)
      .update(rawBody)
      .digest('hex');
    return expected === signature;
  }

  // ----------------------------------------------------------
  // Internal
  // ----------------------------------------------------------

  private async post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const sign = crypto
      .createHmac('sha512', this.apiSecret)
      .update(body)
      .digest('hex');

    const resp = await fetch(`${this.apiUrl}${path}`, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Processing-Key':      this.apiKey,
        'X-Processing-Signature': sign,        // correct header name per CoinsPaid docs
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`CoinsPaid API ${resp.status} on ${path}: ${text}`);
    }

    const json = (await resp.json()) as { data: T };
    return json.data;
  }
}
