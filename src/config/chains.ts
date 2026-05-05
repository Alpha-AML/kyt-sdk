import type { EvmChain, SupportedChain } from '../types.js';

export interface ChainMeta {
  name: string;
  chainId?: number;
  nativeSymbol: string;
  /** Minimum native balance (wei) before gas top-up triggers. */
  defaultMinGasWei: bigint;
  /** Amount (wei) swept from reserve on each top-up. */
  defaultTopUpWei: bigint;
  /** Alpha AML chain identifier used in the report-v1 endpoint. */
  amlChainId: string;
  isTron: boolean;
}

export const CHAIN_META: Record<SupportedChain, ChainMeta> = {
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    nativeSymbol: 'ETH',
    defaultMinGasWei: 3_000_000_000_000_000n,   // 0.003 ETH
    defaultTopUpWei:  10_000_000_000_000_000n,   // 0.01 ETH
    amlChainId: 'ethereum',
    isTron: false,
  },
  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    nativeSymbol: 'ETH',
    defaultMinGasWei: 100_000_000_000_000n,      // 0.0001 ETH
    defaultTopUpWei:  500_000_000_000_000n,       // 0.0005 ETH
    amlChainId: 'arbitrum',
    isTron: false,
  },
  base: {
    name: 'Base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    defaultMinGasWei: 100_000_000_000_000n,      // 0.0001 ETH
    defaultTopUpWei:  500_000_000_000_000n,       // 0.0005 ETH
    amlChainId: 'base',
    isTron: false,
  },
  bsc: {
    name: 'BNB Smart Chain',
    chainId: 56,
    nativeSymbol: 'BNB',
    defaultMinGasWei: 1_000_000_000_000_000n,    // 0.001 BNB
    defaultTopUpWei:  5_000_000_000_000_000n,    // 0.005 BNB
    amlChainId: 'bsc',
    isTron: false,
  },
  tron: {
    name: 'Tron',
    nativeSymbol: 'TRX',
    defaultMinGasWei: 30_000_000n,               // 30 TRX (in sun, 1 TRX = 1e6 sun)
    defaultTopUpWei:  100_000_000n,              // 100 TRX
    amlChainId: 'tron',
    isTron: true,
  },
};

export const EVM_CHAINS: EvmChain[] = ['ethereum', 'arbitrum', 'base', 'bsc'];

export function isEvmChain(chain: SupportedChain): chain is EvmChain {
  return EVM_CHAINS.includes(chain as EvmChain);
}

export function isTronChain(chain: SupportedChain): boolean {
  return chain === 'tron';
}
