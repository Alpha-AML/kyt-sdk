import 'dotenv/config';
import { isAddress } from 'viem';
import { v4 as uuidv4 } from 'uuid';
import type {
  KytSdkConfig,
  SupportedChain,
  EvmChain,
  TrackingWallet,
  CreateTrackingWalletOptions,
  DetectedTransaction,
  ManualTransferOptions,
  ManualTransferResult,
  SdkEvents,
  TokenConfig,
} from './types.js';
import { isEvmChain } from './config/chains.js';
import { resolveTokens, findToken } from './config/tokens.js';
import { HdWalletManager } from './wallet/hd-wallet.js';
import { SqliteStorage } from './storage/sqlite.storage.js';
import { KytService } from './kyt/kyt.service.js';
import { SdkEventBus } from './events/event-bus.js';
import { WebhookDelivery } from './events/webhook.js';
import { EvmMonitor } from './monitor/evm.monitor.js';
import { TronMonitor } from './monitor/tron.monitor.js';
import { GasManager } from './gas/gas.manager.js';
import { EvmTransferService } from './transfer/evm.transfer.js';
import { TronTransferService } from './transfer/tron.transfer.js';

type Handler<T> = (data: T) => void | Promise<void>;

export class KytSDK {
  private storage!:      SqliteStorage;
  private hdWallet!:     HdWalletManager;
  private kytService!:   KytService;
  private gasManager!:   GasManager;
  private evmTransfer!:  EvmTransferService;
  private tronTransfer!: TronTransferService | null;
  private evmMonitor!:   EvmMonitor;
  private tronMonitor!:  TronMonitor | null;
  private bus:           SdkEventBus;
  private webhook:       WebhookDelivery | null = null;

  private readonly cfg:  KytSdkConfig;
  private initialized = false;

  // Resolved token lists per chain (populated during initialize)
  private chainTokens: Partial<Record<SupportedChain, TokenConfig[]>> = {};

  constructor(config: KytSdkConfig) {
    this.cfg = config;
    this.bus  = new SdkEventBus();
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Resolve master seed and build HD wallet
    const seed     = await this.cfg.secrets.getMasterSeed();
    this.hdWallet  = new HdWalletManager(seed);

    // Storage
    this.storage = new SqliteStorage(this.cfg.dbPath ?? './kyt-sdk.db');

    // KYT service
    this.kytService = new KytService(() => this.cfg.secrets.getAlphaAmlApiKey());

    // Resolve token lists
    for (const chain of Object.keys(this.cfg.chains) as SupportedChain[]) {
      this.chainTokens[chain] = resolveTokens(
        chain,
        this.cfg.tokens?.[chain],
        this.cfg.additionalTokens?.[chain],
      );
    }

    // Gas manager
    const rpcUrls: Partial<Record<SupportedChain, string>> = {};
    for (const [c, cfg] of Object.entries(this.cfg.chains) as [SupportedChain, { rpcUrl: string }][]) {
      rpcUrls[c] = cfg.rpcUrl;
    }
    this.gasManager = new GasManager(
      rpcUrls,
      this.cfg.gas ?? {},
      this.bus,
      () => this.cfg.secrets.getGasReservePrivateKey(),
    );

    // EVM transfer service
    const evmRpcUrls: Partial<Record<EvmChain, string>> = {};
    for (const [c, cfg] of Object.entries(this.cfg.chains) as [SupportedChain, { rpcUrl: string }][]) {
      if (isEvmChain(c)) evmRpcUrls[c] = cfg.rpcUrl;
    }
    this.evmTransfer = new EvmTransferService(evmRpcUrls);

    // Tron transfer service
    const tronCfg = this.cfg.chains['tron'];
    if (tronCfg) {
      this.tronTransfer = new TronTransferService(tronCfg.rpcUrl, tronCfg.tronGridApiKey);
    } else {
      this.tronTransfer = null;
    }

    // Webhook
    if (this.cfg.webhookUrl) {
      const getSecret = this.cfg.secrets.getWebhookSecret
        ? () => this.cfg.secrets.getWebhookSecret!()
        : null;
      this.webhook = new WebhookDelivery(this.cfg.webhookUrl, getSecret);
    }

    // Monitors
    const callbacks = {
      onTransactionDetected:  (tx: DetectedTransaction) => this.handleDetected(tx),
      onTransactionConfirmed: (tx: DetectedTransaction) => this.handleConfirmed(tx),
      onError: (err: Error, walletId: string, chain: SupportedChain) => {
        this.emitEvent('error', { error: err, walletId, chain, context: 'monitor' });
      },
    };

    this.evmMonitor = new EvmMonitor(
      evmRpcUrls,
      this.storage,
      this.bus,
      callbacks,
      this.cfg.confirmationsRequired ?? 20,
    );

    if (tronCfg) {
      this.tronMonitor = new TronMonitor(
        tronCfg.rpcUrl,
        tronCfg.tronGridApiKey,
        this.storage,
        this.bus,
        callbacks,
      );
    } else {
      this.tronMonitor = null;
    }

    // Resume monitoring all active wallets
    const activeWallets = this.storage.listActiveWallets();
    for (const wallet of activeWallets) {
      this.startMonitoringWallet(wallet);
    }

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.evmMonitor?.stopAll();
    this.tronMonitor?.stopAll();
    this.storage?.close();
    this.bus.removeAllListeners();
    this.initialized = false;
  }

  // ----------------------------------------------------------
  // Wallet management
  // ----------------------------------------------------------

  async createTrackingWallet(options: CreateTrackingWalletOptions): Promise<TrackingWallet> {
    this.assertInitialized();
    this.validateWalletOptions(options);

    const index = options.index ?? (this.storage.maxWalletIndex() + 1);

    // Derive addresses
    let evmAddress:  string | undefined;
    let tronAddress: string | undefined;

    const hasEvm  = options.chains.some(isEvmChain);
    const hasTron = options.chains.includes('tron');

    if (hasEvm)  evmAddress  = this.hdWallet.deriveEvm(index).address;
    if (hasTron) tronAddress = this.hdWallet.deriveTron(index).address;

    const wallet: TrackingWallet = {
      id:                 uuidv4(),
      index,
      evmAddress,
      tronAddress,
      chains:             options.chains,
      destinationAddress: options.destinationAddress,
      riskThreshold:      options.riskThreshold  ?? this.cfg.riskThreshold  ?? 50,
      pollingIntervalMs:  options.pollingIntervalMs ?? this.cfg.pollingIntervalMs ?? 60_000,
      label:              options.label,
      status:             'active',
      createdAt:          new Date(),
    };

    this.storage.upsertWallet(wallet);
    this.startMonitoringWallet(wallet);
    return wallet;
  }

  getTrackingWallet(id: string): TrackingWallet | undefined {
    this.assertInitialized();
    return this.storage.getWallet(id);
  }

  listTrackingWallets(): TrackingWallet[] {
    this.assertInitialized();
    return this.storage.listWallets();
  }

  pauseTrackingWallet(id: string): void {
    this.assertInitialized();
    const wallet = this.storage.getWallet(id);
    if (!wallet) throw new Error(`Tracking wallet "${id}" not found`);
    this.evmMonitor.stopWallet(id);
    this.tronMonitor?.stopWallet(id);
    this.storage.upsertWallet({ ...wallet, status: 'paused' });
  }

  resumeTrackingWallet(id: string): void {
    this.assertInitialized();
    const wallet = this.storage.getWallet(id);
    if (!wallet) throw new Error(`Tracking wallet "${id}" not found`);
    const active = { ...wallet, status: 'active' as const };
    this.storage.upsertWallet(active);
    this.startMonitoringWallet(active);
  }

  getTransactions(walletId: string): DetectedTransaction[] {
    this.assertInitialized();
    return this.storage.listTransactions(walletId);
  }

  getPendingTransactions(walletId: string): DetectedTransaction[] {
    this.assertInitialized();
    return this.storage.listPendingTransactions(walletId);
  }

  // ----------------------------------------------------------
  // Manual transfer (admin escape hatch)
  // ----------------------------------------------------------

  async manualTransfer(options: ManualTransferOptions): Promise<ManualTransferResult> {
    this.assertInitialized();

    const { walletIndex, chain, destinationAddress, tokenAddress, amount } = options;

    if (!Number.isInteger(walletIndex) || walletIndex < 0) {
      throw new Error('walletIndex must be a non-negative integer');
    }
    if (!destinationAddress) throw new Error('destinationAddress is required');

    if (chain === 'tron') {
      return this.manualTransferTron(walletIndex, destinationAddress, tokenAddress, amount);
    }
    return this.manualTransferEvm(chain as EvmChain, walletIndex, destinationAddress, tokenAddress, amount);
  }

  // ----------------------------------------------------------
  // Event API
  // ----------------------------------------------------------

  on<K extends keyof SdkEvents>(event: K, handler: Handler<SdkEvents[K]>): void {
    this.bus.on(event, handler);
  }

  off<K extends keyof SdkEvents>(event: K, handler: Handler<SdkEvents[K]>): void {
    this.bus.off(event, handler);
  }

  // ----------------------------------------------------------
  // Static utilities
  // ----------------------------------------------------------

  static generateSeed(): string     { return HdWalletManager.generateSeed(); }
  static generateMnemonic(): string { return HdWalletManager.generateMnemonic(); }
  static mnemonicToSeed(mnemonic: string, passphrase?: string): string {
    return HdWalletManager.mnemonicToSeed(mnemonic, passphrase);
  }

  // ----------------------------------------------------------
  // Internal: transaction lifecycle
  // ----------------------------------------------------------

  private async handleDetected(_tx: DetectedTransaction): Promise<void> {
    // Just emit — actual processing happens after confirmation
    await this.dispatchWebhook('transaction.detected', { transaction: _tx });
  }

  private async handleConfirmed(tx: DetectedTransaction): Promise<void> {
    // Guard: atomically transition from pending_kyt → processing by checking current state.
    // If another handler already processed this transaction, skip it.
    const current = this.storage.getTransaction(tx.id);
    if (!current || current.status !== 'pending_kyt') return;

    await this.dispatchWebhook('transaction.confirmed', { transaction: tx });
    this.emitEvent('kyt.checking', { transaction: tx, sender: tx.sender });
    await this.dispatchWebhook('kyt.checking', { transaction: tx, sender: tx.sender });

    try {
      const report = await this.kytService.check(tx.sender, tx.chain);
      const score  = KytService.extractScore(report);

      const wallet = this.storage.getWallet(tx.walletId);
      if (!wallet) return;

      const threshold = wallet.riskThreshold;

      if (score > threshold) {
        this.storage.updateTransactionStatus(tx.id, 'blocked', { kytScore: score, kytResponse: report });
        this.emitEvent('kyt.blocked', { transaction: tx, score, report });
        await this.dispatchWebhook('kyt.blocked', { transaction: tx, score, report });
      } else {
        this.storage.updateTransactionStatus(tx.id, 'approved', { kytScore: score, kytResponse: report });
        this.emitEvent('kyt.passed', { transaction: tx, score, report });
        await this.dispatchWebhook('kyt.passed', { transaction: tx, score, report });
        await this.tryForwardFunds(wallet);
      }
    } catch (err) {
      this.emitEvent('error', {
        walletId: tx.walletId,
        chain:    tx.chain,
        error:    err instanceof Error ? err : new Error(String(err)),
        context:  'kyt_check',
      });
    }
  }

  /**
   * Attempts to forward approved funds.
   *
   * Per the "hold everything" rule: forwarding only occurs when ALL transactions
   * for the wallet are in a terminal state (no pending confirmations or KYT checks).
   * Only the approved-token amounts are forwarded; blocked amounts remain on the wallet.
   */
  private async tryForwardFunds(wallet: TrackingWallet): Promise<void> {
    if (!this.storage.allTransactionsResolved(wallet.id)) return;

    const approved = this.storage.listApprovedPendingForward(wallet.id);
    if (approved.length === 0) return;

    // Group by (chain, tokenAddress) and sum amounts
    const groups = new Map<string, { chain: SupportedChain; tokenAddress: string; tokenSymbol: string; decimals: number; ids: string[]; totalAmount: bigint }>();

    for (const tx of approved) {
      const key = `${tx.chain}:${tx.tokenAddress}`;
      const existing = groups.get(key);
      if (existing) {
        existing.totalAmount += tx.amount;
        existing.ids.push(tx.id);
      } else {
        groups.set(key, {
          chain:        tx.chain,
          tokenAddress: tx.tokenAddress,
          tokenSymbol:  tx.tokenSymbol,
          decimals:     tx.decimals,
          ids:          [tx.id],
          totalAmount:  tx.amount,
        });
      }
    }

    for (const group of groups.values()) {
      try {
        await this.forwardGroup(wallet, group);
        this.storage.markTransactionsForwarded(group.ids);
      } catch (err) {
        this.emitEvent('error', {
          walletId: wallet.id,
          chain:    group.chain,
          error:    err instanceof Error ? err : new Error(String(err)),
          context:  'forward_funds',
        });
      }
    }
  }

  private async forwardGroup(
    wallet: TrackingWallet,
    group: {
      chain: SupportedChain;
      tokenAddress: string;
      tokenSymbol: string;
      totalAmount: bigint;
    },
  ): Promise<void> {
    const { chain, tokenAddress, tokenSymbol, totalAmount } = group;

    this.emitEvent('transfer.initiated', {
      walletId:    wallet.id,
      chain,
      token:       tokenSymbol,
      amount:      totalAmount,
      destination: wallet.destinationAddress,
    });
    await this.dispatchWebhook('transfer.initiated', {
      walletId: wallet.id, chain, token: tokenSymbol, amount: totalAmount, destination: wallet.destinationAddress,
    });

    let txHash: string;

    if (chain === 'tron') {
      if (!this.tronTransfer || !wallet.tronAddress) throw new Error('Tron not configured');
      const privKey = this.hdWallet.deriveTron(wallet.index).privateKey;
      txHash = await this.tronTransfer.transferToken(privKey, tokenAddress, wallet.destinationAddress, totalAmount);
    } else {
      if (!wallet.evmAddress) throw new Error('EVM address not set');
      // Ensure gas before sending
      await this.gasManager.ensureGas(wallet.id, chain, wallet.evmAddress);
      const derived  = this.hdWallet.deriveEvm(wallet.index);
      const privKey  = derived.privateKey as `0x${string}`;
      txHash = await this.evmTransfer.transferToken(
        chain as EvmChain,
        privKey,
        tokenAddress as `0x${string}`,
        wallet.destinationAddress as `0x${string}`,
        totalAmount,
      );
    }

    this.emitEvent('transfer.completed', { walletId: wallet.id, chain, txHash, token: tokenSymbol, amount: totalAmount });
    await this.dispatchWebhook('transfer.completed', { walletId: wallet.id, chain, txHash, token: tokenSymbol, amount: totalAmount });
  }

  // ----------------------------------------------------------
  // Internal: manual transfer helpers
  // ----------------------------------------------------------

  private async manualTransferEvm(
    chain: EvmChain,
    walletIndex: number,
    toAddress: string,
    tokenAddress?: string,
    amount?: bigint,
  ): Promise<ManualTransferResult> {
    const derived  = this.hdWallet.deriveEvm(walletIndex);
    const privKey  = derived.privateKey as `0x${string}`;
    const fromAddr = derived.address;

    await this.gasManager.ensureGas(`manual-${walletIndex}`, chain, fromAddr);

    if (tokenAddress) {
      const tokens = this.chainTokens[chain] ?? [];
      const token  = findToken(chain, tokenAddress, tokens);
      const txHash = await this.evmTransfer.transferToken(
        chain,
        privKey,
        tokenAddress as `0x${string}`,
        toAddress as `0x${string}`,
        amount,
      );
      return { txHash, amount: amount ?? 0n, tokenSymbol: token?.symbol ?? 'ERC20', chain };
    }

    const txHash = await this.evmTransfer.transferNative(chain, privKey, toAddress as `0x${string}`, amount);
    return { txHash, amount: amount ?? 0n, tokenSymbol: 'ETH', chain };
  }

  private async manualTransferTron(
    walletIndex: number,
    toAddress:   string,
    tokenAddress?: string,
    amount?: bigint,
  ): Promise<ManualTransferResult> {
    if (!this.tronTransfer) throw new Error('Tron is not configured in this SDK instance');

    const derived  = this.hdWallet.deriveTron(walletIndex);
    const privKey  = derived.privateKey;

    if (tokenAddress) {
      const tokens = this.chainTokens['tron'] ?? [];
      const token  = findToken('tron', tokenAddress, tokens);
      const txHash = await this.tronTransfer.transferToken(privKey, tokenAddress, toAddress, amount);
      return { txHash, amount: amount ?? 0n, tokenSymbol: token?.symbol ?? 'TRC20', chain: 'tron' };
    }

    const txHash = await this.tronTransfer.transferNative(privKey, toAddress, amount);
    return { txHash, amount: amount ?? 0n, tokenSymbol: 'TRX', chain: 'tron' };
  }

  // ----------------------------------------------------------
  // Internal: monitor orchestration
  // ----------------------------------------------------------

  private startMonitoringWallet(wallet: TrackingWallet): void {
    const evmChains  = wallet.chains.filter(isEvmChain);
    const hasTron    = wallet.chains.includes('tron');

    if (evmChains.length > 0 && wallet.evmAddress) {
      this.evmMonitor.startWallet(wallet, this.evmTokensForWallet(wallet));
    }
    if (hasTron && wallet.tronAddress && this.tronMonitor) {
      this.tronMonitor.startWallet(wallet, this.chainTokens['tron'] ?? []);
    }
  }

  private evmTokensForWallet(wallet: TrackingWallet): TokenConfig[] {
    const tokens: TokenConfig[] = [];
    for (const chain of wallet.chains) {
      if (isEvmChain(chain)) {
        tokens.push(...(this.chainTokens[chain] ?? []));
      }
    }
    // Deduplicate by lowercase address
    const seen = new Set<string>();
    return tokens.filter(t => {
      const key = t.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ----------------------------------------------------------
  // Internal: event helpers
  // ----------------------------------------------------------

  private emitEvent<K extends keyof SdkEvents>(event: K, data: SdkEvents[K]): void {
    this.bus.emit(event, data);
  }

  private async dispatchWebhook<K extends keyof SdkEvents>(event: K, data: SdkEvents[K]): Promise<void> {
    if (!this.webhook) return;
    try {
      await this.webhook.deliver(event, data);
    } catch (err) {
      this.emitEvent('error', {
        error:   err instanceof Error ? err : new Error(String(err)),
        context: `webhook:${event}`,
      });
    }
  }

  // ----------------------------------------------------------
  // Validation
  // ----------------------------------------------------------

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('KytSDK is not initialized — call sdk.initialize() first');
  }

  private validateWalletOptions(options: CreateTrackingWalletOptions): void {
    if (!options.chains || options.chains.length === 0) {
      throw new Error('At least one chain must be specified');
    }
    for (const chain of options.chains) {
      if (!this.cfg.chains[chain]) {
        throw new Error(`Chain "${chain}" is not configured in KytSdkConfig.chains`);
      }
    }
    if (!options.destinationAddress) {
      throw new Error('destinationAddress is required');
    }

    // Validate destination address format matches chain type
    const hasEvm  = options.chains.some(isEvmChain);
    const hasTron = options.chains.includes('tron');
    if (hasEvm && !isAddress(options.destinationAddress, { strict: false }) && !hasTron) {
      throw new Error(
        `destinationAddress "${options.destinationAddress}" is not a valid EVM address for chains: ${options.chains.join(', ')}`,
      );
    }
    if (hasTron && !options.destinationAddress.startsWith('T') && !hasEvm) {
      throw new Error(
        `destinationAddress "${options.destinationAddress}" does not appear to be a valid Tron address (must start with T)`,
      );
    }

    if (options.index !== undefined) {
      if (!Number.isInteger(options.index) || options.index < 0) {
        throw new Error('index must be a non-negative integer');
      }
      // Prevent overwriting an existing wallet with a different destination
      const existing = this.storage.listWallets().find(w => w.index === options.index);
      if (existing) {
        throw new Error(
          `A tracking wallet at index ${options.index} (id: ${existing.id}) already exists. Use a different index.`,
        );
      }
    }

  }
}
