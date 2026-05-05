import type { SupportedChain, DetectedTransaction, TrackingWallet, TokenConfig } from '../types.js';
import type { SqliteStorage } from '../storage/sqlite.storage.js';
import type { SdkEventBus } from '../events/event-bus.js';

// TronGrid event response shapes
interface TronEventItem {
  transaction_id: string;
  block_number:   number;
  block_timestamp: number;
  contract_address: string;
  event_name:     string;
  result: {
    from?: string;
    to?:   string;
    value?: string;
  };
}

interface TronEventsResponse {
  data:        TronEventItem[];
  meta?:       { fingerprint?: string };
  success:     boolean;
}

export interface TronMonitorCallbacks {
  onTransactionDetected:  (tx: DetectedTransaction) => Promise<void>;
  onTransactionConfirmed: (tx: DetectedTransaction) => Promise<void>;
  onError:                (err: Error, walletId: string, chain: SupportedChain) => void;
}

interface ActiveWallet {
  wallet:  TrackingWallet;
  tokens:  TokenConfig[];
  timer:   ReturnType<typeof setTimeout>;
}

export class TronMonitor {
  private readonly active = new Map<string, ActiveWallet>();
  private readonly baseUrl: string;
  private readonly apiKeyHeader: Record<string, string>;

  constructor(
    rpcUrl: string,
    tronGridApiKey: string | undefined,
    private readonly storage: SqliteStorage,
    private readonly bus: SdkEventBus,
    private readonly callbacks: TronMonitorCallbacks,
  ) {
    this.baseUrl      = rpcUrl.replace(/\/$/, '');
    this.apiKeyHeader = tronGridApiKey ? { 'TRON-PRO-API-KEY': tronGridApiKey } : {};
  }

  startWallet(wallet: TrackingWallet, tokens: TokenConfig[]): void {
    if (this.active.has(wallet.id)) return;
    if (!wallet.tronAddress)        return;

    const timer = this.schedulePolling(wallet, tokens);
    this.active.set(wallet.id, { wallet, tokens, timer });
  }

  stopWallet(walletId: string): void {
    const entry = this.active.get(walletId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.active.delete(walletId);
  }

  stopAll(): void {
    for (const { timer } of this.active.values()) clearTimeout(timer);
    this.active.clear();
  }

  private schedulePolling(
    wallet: TrackingWallet,
    tokens: TokenConfig[],
  ): ReturnType<typeof setTimeout> {
    return setTimeout(async () => {
      try {
        await this.poll(wallet, tokens);
      } catch (err) {
        this.callbacks.onError(
          err instanceof Error ? err : new Error(String(err)),
          wallet.id,
          'tron',
        );
      } finally {
        const entry = this.active.get(wallet.id);
        if (entry) {
          entry.timer = this.schedulePolling(wallet, tokens);
        }
      }
    }, wallet.pollingIntervalMs);
  }

  private async poll(wallet: TrackingWallet, tokens: TokenConfig[]): Promise<void> {
    const address = wallet.tronAddress!;

    for (const token of tokens) {
      await this.pollToken(wallet, address, token);
    }

    // Re-check pending-confirmation items — TronGrid confirmed events are final
    const pending = this.storage
      .listPendingTransactions(wallet.id)
      .filter(tx => tx.chain === 'tron' && tx.status === 'pending_confirmations');

    for (const tx of pending) {
      this.storage.updateTransactionStatus(tx.id, 'pending_kyt');
      const updated = { ...tx, status: 'pending_kyt' as const };
      await this.callbacks.onTransactionConfirmed(updated);
      this.bus.emit('transaction.confirmed', { transaction: updated });
    }
  }

  private async pollToken(
    wallet: TrackingWallet,
    tronAddress: string,
    token: TokenConfig,
  ): Promise<void> {
    // TronGrid: only confirmed events — this handles confirmations server-side
    const url = `${this.baseUrl}/v1/contracts/${token.address}/events`
      + `?event_name=Transfer&only_confirmed=true&limit=200`
      + `&min_block_timestamp=${this.getMinTimestamp(wallet.id)}`;

    let fingerprint: string | undefined;

    do {
      const fetchUrl = fingerprint ? `${url}&fingerprint=${fingerprint}` : url;
      const response = await fetch(fetchUrl, { headers: this.apiKeyHeader });

      if (!response.ok) {
        throw new Error(`TronGrid HTTP ${response.status} for token ${token.symbol}`);
      }

      const body = (await response.json()) as TronEventsResponse;
      if (!body.success || !body.data) break;

      for (const item of body.data) {
        // Skip events with missing required fields
        if (!item?.transaction_id || !item.result) continue;
        const to = item.result.to;
        if (!to || to.toLowerCase() !== tronAddress.toLowerCase()) continue;
        await this.processEvent(item, wallet, token);
      }

      fingerprint = body.meta?.fingerprint;
    } while (fingerprint);
  }

  private eventCounter = new Map<string, number>();

  private async processEvent(
    item: TronEventItem,
    wallet: TrackingWallet,
    token: TokenConfig,
  ): Promise<void> {
    // Use a per-tx counter to uniquely identify multiple Transfer events in the same tx
    const txCount = (this.eventCounter.get(item.transaction_id) ?? 0);
    const id = `${item.transaction_id}:${txCount}`;
    this.eventCounter.set(item.transaction_id, txCount + 1);
    if (this.storage.getTransaction(id)) return;

    const sender = item.result.from ?? '';
    if (!sender) return;

    const amount = BigInt(item.result.value ?? '0');

    // TronGrid "only_confirmed=true" means this is already confirmed (≥19 blocks)
    const detectedTx: DetectedTransaction = {
      id,
      walletId:     wallet.id,
      chain:        'tron',
      txHash:       item.transaction_id,
      blockNumber:  item.block_number,
      sender:       sender,
      tokenAddress: token.address,
      tokenSymbol:  token.symbol,
      amount,
      decimals:     token.decimals,
      status:       'pending_kyt',
      detectedAt:   new Date(),
    };

    this.storage.insertTransaction(detectedTx);
    await this.callbacks.onTransactionDetected(detectedTx);
    this.bus.emit('transaction.detected', { transaction: detectedTx });
    await this.callbacks.onTransactionConfirmed(detectedTx);
    this.bus.emit('transaction.confirmed', { transaction: detectedTx });

    // Advance the timestamp cursor to avoid re-fetching old events
    this.storage.setLastBlock(wallet.id, 'tron', item.block_number);
  }

  /**
   * Uses the last known block number as a proxy for "min_block_timestamp" to avoid
   * re-fetching old events.  TronGrid accepts a millisecond timestamp here.
   */
  private getMinTimestamp(walletId: string): number {
    const lastBlock = this.storage.getLastBlock(walletId, 'tron');
    // Each Tron block is ~3s.  We offset by 1000 blocks to avoid boundary misses.
    const safeBlock = Math.max(0, lastBlock - 1000);
    // Convert block to approximate timestamp (Tron genesis is ~2018-06-25; not critical here)
    // We just use epoch 0 for first run and lastBlock * 3000 ms as a rough estimate.
    return safeBlock === 0 ? 0 : safeBlock * 3_000;
  }
}
