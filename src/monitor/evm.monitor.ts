import {
  createPublicClient,
  http,
  parseAbi,
  type PublicClient,
  type Log,
  type Address,
  type Chain,
} from 'viem';
import { mainnet, arbitrum, base, bsc } from 'viem/chains';
import type { EvmChain, SupportedChain, DetectedTransaction, TrackingWallet, TokenConfig } from '../types.js';
import type { SqliteStorage } from '../storage/sqlite.storage.js';
import type { SdkEventBus } from '../events/event-bus.js';
import { v4 as uuidv4 } from 'uuid';

const TRANSFER_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const VIEM_CHAINS: Record<EvmChain, Chain> = {
  ethereum: mainnet,
  arbitrum: arbitrum,
  base:     base,
  bsc:      bsc as unknown as Chain,
};

export interface EvmMonitorCallbacks {
  onTransactionDetected:  (tx: DetectedTransaction) => Promise<void>;
  onTransactionConfirmed: (tx: DetectedTransaction) => Promise<void>;
  onError:                (err: Error, walletId: string, chain: SupportedChain) => void;
}

interface ActiveWallet {
  wallet:  TrackingWallet;
  address: Address;
  tokens:  TokenConfig[];
  timer:   ReturnType<typeof setTimeout>;
}

export class EvmMonitor {
  private readonly clients = new Map<EvmChain, PublicClient>();
  private readonly active  = new Map<string, ActiveWallet>(); // key: walletId
  private readonly confirmationsRequired: number;

  constructor(
    private readonly rpcUrls: Partial<Record<EvmChain, string>>,
    private readonly storage: SqliteStorage,
    private readonly bus: SdkEventBus,
    private readonly callbacks: EvmMonitorCallbacks,
    confirmationsRequired: number,
  ) {
    this.confirmationsRequired = confirmationsRequired;

    for (const [chain, rpcUrl] of Object.entries(rpcUrls) as [EvmChain, string][]) {
      const client = createPublicClient({
        chain: VIEM_CHAINS[chain],
        transport: http(rpcUrl, { retryCount: 3, retryDelay: 1_000 }),
      });
      this.clients.set(chain, client);
    }
  }

  startWallet(wallet: TrackingWallet, tokens: TokenConfig[]): void {
    if (this.active.has(wallet.id)) return;

    const evmChains = wallet.chains.filter(c => c !== 'tron') as EvmChain[];
    if (evmChains.length === 0) return;
    if (!wallet.evmAddress) return;

    const address = wallet.evmAddress as Address;
    const timer   = this.schedulePolling(wallet, address, tokens, evmChains);
    this.active.set(wallet.id, { wallet, address, tokens, timer });
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
    address: Address,
    tokens: TokenConfig[],
    chains: EvmChain[],
  ): ReturnType<typeof setTimeout> {
    return setTimeout(async () => {
      try {
        await this.poll(wallet, address, tokens, chains);
      } catch (err) {
        this.callbacks.onError(
          err instanceof Error ? err : new Error(String(err)),
          wallet.id,
          chains[0] ?? 'ethereum',
        );
      } finally {
        const entry = this.active.get(wallet.id);
        if (entry) {
          entry.timer = this.schedulePolling(wallet, address, tokens, chains);
        }
      }
    }, wallet.pollingIntervalMs);
  }

  private async poll(
    wallet: TrackingWallet,
    address: Address,
    tokens: TokenConfig[],
    chains: EvmChain[],
  ): Promise<void> {
    await Promise.all(
      chains.map(chain => this.pollChain(wallet, address, tokens, chain)),
    );
  }

  private async pollChain(
    wallet: TrackingWallet,
    address: Address,
    tokens: TokenConfig[],
    chain: EvmChain,
  ): Promise<void> {
    const client = this.clients.get(chain);
    if (!client) return;

    const currentBlock = Number(await client.getBlockNumber());
    const fromBlock    = Math.max(this.storage.getLastBlock(wallet.id, chain), currentBlock - 1000);

    if (fromBlock >= currentBlock) {
      await this.reprocessPendingConfirmations(wallet, chain, currentBlock);
      return;
    }

    for (const token of tokens) {
      const logs = await client.getLogs({
        address:   token.address as Address,
        event:     TRANSFER_ABI[0]!,
        args:      { to: address },
        fromBlock: BigInt(fromBlock + 1),
        toBlock:   BigInt(currentBlock),
      });

      for (const log of logs) {
        await this.processLog(log, wallet, chain, token, currentBlock);
      }
    }

    this.storage.setLastBlock(wallet.id, chain, currentBlock);
    await this.reprocessPendingConfirmations(wallet, chain, currentBlock);
  }

  private async processLog(
    log: Log,
    wallet: TrackingWallet,
    chain: EvmChain,
    token: TokenConfig,
    currentBlock: number,
  ): Promise<void> {
    const txHash   = log.transactionHash;
    const logIndex = log.logIndex ?? 0;
    const id       = `${txHash}:${logIndex}`;

    if (this.storage.getTransaction(id)) return;

    const fromTopic = log.topics[1];
    if (!fromTopic) return;
    const sender  = ('0x' + fromTopic.slice(-40)) as Address;
    const amount  = (log as { args?: { value?: bigint } }).args?.value ?? 0n;
    const blockNum = Number(log.blockNumber ?? 0n);

    const status = blockNum > 0 && currentBlock - blockNum >= this.confirmationsRequired
      ? 'pending_kyt' as const
      : 'pending_confirmations' as const;

    const detectedTx: DetectedTransaction = {
      id,
      walletId:     wallet.id,
      chain,
      txHash:       txHash ?? '',
      blockNumber:  blockNum,
      sender:       sender.toLowerCase(),
      tokenAddress: token.address,
      tokenSymbol:  token.symbol,
      amount,
      decimals:     token.decimals,
      status,
      detectedAt:   new Date(),
    };

    this.storage.insertTransaction(detectedTx);
    await this.callbacks.onTransactionDetected(detectedTx);
    this.bus.emit('transaction.detected', { transaction: detectedTx });

    if (status === 'pending_kyt') {
      await this.callbacks.onTransactionConfirmed(detectedTx);
      this.bus.emit('transaction.confirmed', { transaction: detectedTx });
    }
  }

  private async reprocessPendingConfirmations(
    wallet: TrackingWallet,
    chain: EvmChain,
    currentBlock: number,
  ): Promise<void> {
    const pending = this.storage
      .listPendingTransactions(wallet.id)
      .filter(tx => tx.chain === chain && tx.status === 'pending_confirmations');

    for (const tx of pending) {
      if (currentBlock - tx.blockNumber >= this.confirmationsRequired) {
        this.storage.updateTransactionStatus(tx.id, 'pending_kyt');
        const updated = { ...tx, status: 'pending_kyt' as const };
        await this.callbacks.onTransactionConfirmed(updated);
        this.bus.emit('transaction.confirmed', { transaction: updated });
      }
    }
  }
}
