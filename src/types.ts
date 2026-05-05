// ============================================================
// Alpha AML KYT SDK — Core Types
// ============================================================

export type EvmChain = 'ethereum' | 'arbitrum' | 'base' | 'bsc';
export type TronChain = 'tron';
export type SupportedChain = EvmChain | TronChain;

// ----------------------------------------------------------
// Token
// ----------------------------------------------------------

export interface TokenConfig {
  symbol: string;
  address: string;
  decimals: number;
}

// ----------------------------------------------------------
// Chain RPC configuration (provided by client)
// ----------------------------------------------------------

export interface ChainRpcConfig {
  /** HTTP(S) RPC endpoint. For Tron, use TronGrid: https://api.trongrid.io */
  rpcUrl: string;
  /** Etherscan-compatible explorer API key (used for log queries on BSC/Arbitrum/Base if RPC doesn't support eth_getLogs). Optional — eth_getLogs via RPC is the primary method. */
  explorerApiKey?: string;
  /** TronGrid API key (recommended for Tron to avoid rate limits). */
  tronGridApiKey?: string;
}

// ----------------------------------------------------------
// Secrets provider interface
// ----------------------------------------------------------

export interface SecretsProvider {
  /** Hex-encoded 32-byte master seed used for BIP32 HD wallet derivation. */
  getMasterSeed(): Promise<string>;
  /** Hex-encoded (no 0x prefix) private key of the gas reserve wallet. */
  getGasReservePrivateKey(): Promise<string>;
  /** Alpha AML API key for KYT checks. */
  getAlphaAmlApiKey(): Promise<string>;
  /** Optional HMAC secret for signing webhook payloads. */
  getWebhookSecret?(): Promise<string>;
}

// ----------------------------------------------------------
// Gas configuration
// ----------------------------------------------------------

export interface GasConfig {
  /**
   * Minimum native balance (in wei / sun) the tracking wallet must hold before a
   * gas top-up is triggered.  Defaults per chain are defined in config/chains.ts.
   */
  minBalanceWei?: bigint;
  /**
   * Amount of native token (in wei / sun) to sweep from the reserve wallet into
   * the tracking wallet each time a top-up is triggered.
   */
  topUpAmountWei?: bigint;
}

// ----------------------------------------------------------
// SDK configuration
// ----------------------------------------------------------

export interface KytSdkConfig {
  /** RPC endpoint(s) per chain.  Only chains listed here are active. */
  chains: Partial<Record<SupportedChain, ChainRpcConfig>>;

  /** Provider that resolves all secrets (seed, reserve key, API key). */
  secrets: SecretsProvider;

  /** Risk score (0-100) above which a transaction is blocked.  Default: 50. */
  riskThreshold?: number;

  /** How often to poll each chain for new transactions, in milliseconds.  Default: 60 000. */
  pollingIntervalMs?: number;

  /** Block confirmations required before a transaction is processed.  Default: 20. */
  confirmationsRequired?: number;

  /** Absolute path to the SQLite database file.  Default: ./kyt-sdk.db */
  dbPath?: string;

  /** URL to receive webhook event notifications. */
  webhookUrl?: string;

  /** Per-chain gas management overrides. */
  gas?: Partial<Record<SupportedChain, GasConfig>>;

  /**
   * Override or extend the default tracked token list per chain.
   * Useful for adding custom tokens without replacing all defaults.
   */
  additionalTokens?: Partial<Record<SupportedChain, TokenConfig[]>>;

  /**
   * Replace the default tracked token list per chain entirely.
   * When set for a chain, additionalTokens is ignored for that chain.
   */
  tokens?: Partial<Record<SupportedChain, TokenConfig[]>>;
}

// ----------------------------------------------------------
// Tracking wallet
// ----------------------------------------------------------

export interface CreateTrackingWalletOptions {
  /** Chain(s) this wallet should monitor.  Must be a subset of config.chains. */
  chains: SupportedChain[];
  /**
   * Where approved funds are forwarded.  For EVM-only wallets this is an 0x
   * address; for a Tron wallet this is a Base58 (T…) address.
   * If the wallet monitors both EVM and Tron, use separate wallets.
   */
  destinationAddress: string;
  /**
   * BIP32 derivation index.  When omitted, the SDK auto-increments from the
   * highest existing index.
   */
  index?: number;
  /** Override the global riskThreshold for this wallet. */
  riskThreshold?: number;
  /** Override the global pollingIntervalMs for this wallet. */
  pollingIntervalMs?: number;
  /** Human-readable label (e.g. order ID, invoice reference). */
  label?: string;
}

export interface TrackingWallet {
  id: string;
  index: number;
  /** EVM address (present when any EVM chain is monitored). */
  evmAddress?: string;
  /** Tron address in Base58 format (present when tron is monitored). */
  tronAddress?: string;
  chains: SupportedChain[];
  destinationAddress: string;
  riskThreshold: number;
  pollingIntervalMs: number;
  label?: string;
  status: 'active' | 'paused' | 'closed';
  createdAt: Date;
}

// ----------------------------------------------------------
// Transactions
// ----------------------------------------------------------

export type TransactionStatus =
  | 'pending_confirmations'
  | 'pending_kyt'
  | 'approved'
  | 'blocked'
  | 'forwarded';

export interface DetectedTransaction {
  /** Composite key: txHash:logIndex (or txHash for native). */
  id: string;
  walletId: string;
  chain: SupportedChain;
  txHash: string;
  blockNumber: number;
  /** Sender decoded from Transfer event log topic[1]. */
  sender: string;
  tokenAddress: string;
  tokenSymbol: string;
  /** Raw amount in smallest unit (no decimal adjustment). */
  amount: bigint;
  decimals: number;
  status: TransactionStatus;
  kytScore?: number;
  kytResponse?: AlphaAmlReport;
  detectedAt: Date;
  processedAt?: Date;
}

// ----------------------------------------------------------
// Alpha AML report (relevant subset)
// ----------------------------------------------------------

export interface AlphaAmlReport {
  report: { generated_at_utc: string };
  wallet: { address: string; blockchain: string; description: string; entity_tag: string };
  risk_assessment: {
    score: number;
    score_max: number;
    risk_level: string;
    blacklisted: boolean;
    blacklist_note: string;
  };
  wallet_statistics: {
    total_transactions_count: number;
    status: string;
  };
}

// ----------------------------------------------------------
// Events
// ----------------------------------------------------------

export interface SdkEvents {
  'transaction.detected': { transaction: DetectedTransaction };
  'transaction.confirmed': { transaction: DetectedTransaction };
  'kyt.checking': { transaction: DetectedTransaction; sender: string };
  'kyt.passed': { transaction: DetectedTransaction; score: number; report: AlphaAmlReport };
  'kyt.blocked': { transaction: DetectedTransaction; score: number; report: AlphaAmlReport };
  'transfer.initiated': {
    walletId: string;
    chain: SupportedChain;
    token: string;
    amount: bigint;
    destination: string;
  };
  'transfer.completed': {
    walletId: string;
    chain: SupportedChain;
    txHash: string;
    token: string;
    amount: bigint;
  };
  'gas.low': {
    walletId: string;
    chain: SupportedChain;
    currentBalance: bigint;
    required: bigint;
  };
  'gas.swept': {
    walletId: string;
    chain: SupportedChain;
    amount: bigint;
    txHash: string;
  };
  'error': {
    walletId?: string;
    chain?: SupportedChain;
    error: Error;
    context: string;
  };
}

// ----------------------------------------------------------
// Manual transfer
// ----------------------------------------------------------

export interface ManualTransferOptions {
  /** HD derivation index of the source tracking wallet. */
  walletIndex: number;
  chain: SupportedChain;
  destinationAddress: string;
  /** ERC-20 / TRC-20 contract address.  Omit to transfer the native token. */
  tokenAddress?: string;
  /** Amount in smallest unit (wei / sun).  Omit to transfer the full balance. */
  amount?: bigint;
}

export interface ManualTransferResult {
  txHash: string;
  amount: bigint;
  tokenSymbol: string;
  chain: SupportedChain;
}
