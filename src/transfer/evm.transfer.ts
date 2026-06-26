import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type PublicClient,
  type WalletClient,
  type Address,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia, arbitrum, arbitrumSepolia, base, bsc } from 'viem/chains';
import type { EvmChain } from '../types.js';

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const VIEM_CHAINS: Record<EvmChain, Chain> = {
  ethereum:           mainnet,
  'ethereum-sepolia': sepolia,
  arbitrum:           arbitrum,
  'arbitrum-sepolia': arbitrumSepolia,
  base:               base,
  bsc:                bsc as unknown as Chain,
};

export class EvmTransferService {
  private readonly publicClients = new Map<EvmChain, PublicClient>();

  constructor(private readonly rpcUrls: Partial<Record<EvmChain, string>>) {
    for (const [chain, url] of Object.entries(rpcUrls) as [EvmChain, string][]) {
      this.publicClients.set(
        chain,
        createPublicClient({ chain: VIEM_CHAINS[chain], transport: http(url) }),
      );
    }
  }

  /**
   * Transfer an ERC-20 token from a tracking wallet to a destination address.
   * @param amount Raw amount in smallest unit.  Pass undefined to transfer full balance.
   */
  async transferToken(
    chain: EvmChain,
    privateKey: `0x${string}`,
    tokenAddress: Address,
    toAddress: Address,
    amount?: bigint,
  ): Promise<string> {
    const client  = this.getPublicClient(chain);
    const wc      = this.buildWalletClient(chain, privateKey);
    const account = privateKeyToAccount(privateKey);

    const actualAmount = amount ?? (await this.getTokenBalance(chain, tokenAddress, account.address));
    if (actualAmount === 0n) throw new Error('Transfer amount is zero');

    const fees        = await client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas * 15n / 10n; // 1.5x buffer against stale estimates

    const hash = await wc.writeContract({
      address:             tokenAddress,
      abi:                 ERC20_ABI,
      functionName:        'transfer',
      args:                [toAddress, actualAmount],
      account,
      chain:               VIEM_CHAINS[chain],
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    await client.waitForTransactionReceipt({ hash, confirmations: 1 });
    return hash;
  }

  /**
   * Transfer native token (ETH / BNB).
   * @param amount Raw amount in wei.  Pass undefined to sweep full balance minus gas.
   */
  async transferNative(
    chain: EvmChain,
    privateKey: `0x${string}`,
    toAddress: Address,
    amount?: bigint,
  ): Promise<string> {
    const client  = this.getPublicClient(chain);
    const wc      = this.buildWalletClient(chain, privateKey);
    const account = privateKeyToAccount(privateKey);

    const fees        = await client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas * 15n / 10n; // 1.5x buffer against stale estimates

    let value: bigint;
    if (amount !== undefined) {
      value = amount;
    } else {
      const balance = await client.getBalance({ address: account.address });
      const gasCost = maxFeePerGas * 21_000n; // conservative upper bound for ETH send
      if (balance <= gasCost) throw new Error('Insufficient native balance to cover gas');
      value = balance - gasCost;
    }

    if (value === 0n) throw new Error('Transfer amount is zero');

    const hash = await wc.sendTransaction({
      account,
      to:                  toAddress,
      value,
      chain:               VIEM_CHAINS[chain],
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    await client.waitForTransactionReceipt({ hash, confirmations: 1 });
    return hash;
  }

  async getTokenBalance(chain: EvmChain, tokenAddress: Address, owner: Address): Promise<bigint> {
    const result = await this.getPublicClient(chain).readContract({
      address:      tokenAddress,
      abi:          ERC20_ABI,
      functionName: 'balanceOf',
      args:         [owner],
    });
    return result as bigint;
  }

  async getNativeBalance(chain: EvmChain, address: Address): Promise<bigint> {
    return this.getPublicClient(chain).getBalance({ address });
  }

  private getPublicClient(chain: EvmChain): PublicClient {
    const c = this.publicClients.get(chain);
    if (!c) throw new Error(`No RPC configured for chain "${chain}"`);
    return c;
  }

  private buildWalletClient(chain: EvmChain, privateKey: `0x${string}`): WalletClient {
    const rpcUrl = this.rpcUrls[chain];
    if (!rpcUrl) throw new Error(`No RPC URL for chain "${chain}"`);
    const account = privateKeyToAccount(privateKey);
    return createWalletClient({ account, chain: VIEM_CHAINS[chain], transport: http(rpcUrl) });
  }
}
