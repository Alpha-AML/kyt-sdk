import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Address,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia, arbitrum, arbitrumSepolia, base, bsc } from 'viem/chains';
import type { EvmChain, SupportedChain, GasConfig } from '../types.js';
import { CHAIN_META } from '../config/chains.js';
import type { SdkEventBus } from '../events/event-bus.js';

const VIEM_CHAINS: Record<EvmChain, Chain> = {
  ethereum:           mainnet,
  'ethereum-sepolia': sepolia,
  arbitrum:           arbitrum,
  'arbitrum-sepolia': arbitrumSepolia,
  base:               base,
  bsc:                bsc as unknown as Chain,
};

export class GasManager {
  private readonly evmPublicClients  = new Map<EvmChain, PublicClient>();
  private reserveAddress: Address | null = null;
  private reservePrivKey: `0x${string}` | null = null;

  private tronRpcUrl:     string | null = null;
  private tronApiKey:     string | null = null;
  private tronReserveKey: string | null = null;

  constructor(
    private readonly rpcUrls:    Partial<Record<SupportedChain, string>>,
    private readonly gasConfigs: Partial<Record<SupportedChain, GasConfig>>,
    private readonly bus:        SdkEventBus,
    private readonly getReserveKey: () => Promise<string>,
  ) {
    for (const [chain, rpcUrl] of Object.entries(rpcUrls) as [SupportedChain, string][]) {
      if (chain === 'tron') {
        this.tronRpcUrl = rpcUrl;
        continue;
      }
      const evmChain = chain as EvmChain;
      this.evmPublicClients.set(
        evmChain,
        createPublicClient({ chain: VIEM_CHAINS[evmChain], transport: http(rpcUrl) }),
      );
    }
  }

  /**
   * Ensures the tracking wallet has enough native tokens to cover at least one transfer.
   * Returns the top-up transaction hash, or null when no top-up was needed.
   */
  async ensureGas(
    walletId: string,
    chain: SupportedChain,
    trackingAddress: string,
  ): Promise<string | null> {
    if (chain === 'tron') {
      return this.ensureGasTron(walletId, trackingAddress);
    }
    return this.ensureGasEvm(walletId, chain as EvmChain, trackingAddress as Address);
  }

  private async ensureGasEvm(
    walletId: string,
    chain: EvmChain,
    trackingAddress: Address,
  ): Promise<string | null> {
    const client = this.evmPublicClients.get(chain);
    if (!client) return null;

    const meta     = CHAIN_META[chain];
    const cfg      = this.gasConfigs[chain] ?? {};
    const minWei   = cfg.minBalanceWei  ?? meta.defaultMinGasWei;
    const topUpWei = cfg.topUpAmountWei ?? meta.defaultTopUpWei;

    const balance = await client.getBalance({ address: trackingAddress });
    if (balance >= minWei) return null;

    this.bus.emit('gas.low', { walletId, chain, currentBalance: balance, required: minWei });

    const { walletClient, account, reserveAddr } = await this.getEvmWalletClient(chain);

    // Safety: verify reserve has enough before sending
    const reserveBalance = await client.getBalance({ address: reserveAddr });
    if (reserveBalance < topUpWei) {
      throw new Error(
        `Gas reserve wallet has insufficient balance on ${chain}: ` +
        `has ${reserveBalance.toString()} wei, needs ${topUpWei.toString()} wei`,
      );
    }

    const fees        = await client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas * 15n / 10n; // 1.5x buffer against stale estimates

    const hash = await walletClient.sendTransaction({
      account,
      to:                  trackingAddress as `0x${string}`,
      value:               topUpWei,
      chain:               VIEM_CHAINS[chain],
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    await client.waitForTransactionReceipt({ hash, confirmations: 1 });

    this.bus.emit('gas.swept', { walletId, chain, amount: topUpWei, txHash: hash });
    return hash;
  }

  private async ensureGasTron(walletId: string, trackingAddress: string): Promise<string | null> {
    if (!this.tronRpcUrl) return null;

    const meta   = CHAIN_META['tron'];
    const cfg    = this.gasConfigs['tron'] ?? {};
    const minSun = cfg.minBalanceWei  ?? meta.defaultMinGasWei;
    const topUp  = cfg.topUpAmountWei ?? meta.defaultTopUpWei;

    const balance = await this.getTrxBalance(trackingAddress);
    if (balance >= minSun) return null;

    this.bus.emit('gas.low', { walletId, chain: 'tron', currentBalance: balance, required: minSun });

    const { TronWeb } = await import('tronweb');
    const reserveKey  = await this.getTronReserveKey();
    const tw = new TronWeb({ fullHost: this.tronRpcUrl, headers: this.apiKeyHeaders() });
    tw.setPrivateKey(reserveKey);

    const reserveAddr = tw.address.fromPrivateKey(reserveKey);
    if (!reserveAddr) throw new Error('Failed to derive Tron address from reserve key');

    if (topUp > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Gas top-up amount ${topUp} exceeds safe integer range for Tron`);
    }
    const txObj  = await tw.transactionBuilder.sendTrx(trackingAddress, Number(topUp), reserveAddr);
    const signed = await tw.trx.sign(txObj, reserveKey);
    const result = await tw.trx.sendRawTransaction(signed);
    const txHash = result.txid ?? '';

    this.bus.emit('gas.swept', { walletId, chain: 'tron', amount: topUp, txHash });
    return txHash;
  }

  private async getTrxBalance(address: string): Promise<bigint> {
    const url  = `${this.tronRpcUrl!.replace(/\/$/, '')}/v1/accounts/${address}`;
    const resp = await fetch(url, { headers: this.apiKeyHeaders() });
    if (!resp.ok) return 0n;
    const json = await resp.json() as { data?: Array<{ balance?: number }> };
    return BigInt(json.data?.[0]?.balance ?? 0);
  }

  private apiKeyHeaders(): Record<string, string> {
    return this.tronApiKey ? { 'TRON-PRO-API-KEY': this.tronApiKey } : {};
  }

  private async getEvmWalletClient(chain: EvmChain): Promise<{
    walletClient: WalletClient;
    account:      ReturnType<typeof privateKeyToAccount>;
    reserveAddr:  Address;
  }> {
    if (!this.reservePrivKey) {
      const raw = await this.getReserveKey();
      this.reservePrivKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
      this.reserveAddress = privateKeyToAccount(this.reservePrivKey).address;
    }

    const rpcUrl = this.rpcUrls[chain];
    if (!rpcUrl) throw new Error(`No RPC URL configured for chain "${chain}"`);

    const account    = privateKeyToAccount(this.reservePrivKey!);
    const walletClient = createWalletClient({
      account,
      chain:     VIEM_CHAINS[chain],
      transport: http(rpcUrl),
    });

    return { walletClient, account, reserveAddr: this.reserveAddress! };
  }

  private async getTronReserveKey(): Promise<string> {
    if (!this.tronReserveKey) {
      this.tronReserveKey = await this.getReserveKey();
    }
    return this.tronReserveKey;
  }
}
