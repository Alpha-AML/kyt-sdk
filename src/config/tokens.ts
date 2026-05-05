import type { SupportedChain, TokenConfig } from '../types.js';

export const DEFAULT_TOKENS: Record<SupportedChain, TokenConfig[]> = {
  ethereum: [
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  ],
  arbitrum: [
    { symbol: 'USDT',   address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    { symbol: 'USDC',   address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { symbol: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
  ],
  base: [
    { symbol: 'USDC',  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'USDbC', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 },
    { symbol: 'USDT',  address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
  ],
  bsc: [
    { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
    { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  ],
  tron: [
    { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
    { symbol: 'USDC', address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',  decimals: 6 },
  ],
};

/** Resolve the effective token list for a chain, applying overrides from SDK config. */
export function resolveTokens(
  chain: SupportedChain,
  override?: TokenConfig[],
  additional?: TokenConfig[],
): TokenConfig[] {
  if (override) return override;
  const base = DEFAULT_TOKENS[chain] ?? [];
  if (additional && additional.length > 0) return [...base, ...additional];
  return base;
}

/** Look up a token by contract address (case-insensitive for EVM). */
export function findToken(
  chain: SupportedChain,
  tokenAddress: string,
  tokens: TokenConfig[],
): TokenConfig | undefined {
  const addr = chain === 'tron' ? tokenAddress : tokenAddress.toLowerCase();
  return tokens.find(t =>
    (chain === 'tron' ? t.address : t.address.toLowerCase()) === addr,
  );
}
