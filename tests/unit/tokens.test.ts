import { describe, it, expect } from 'vitest';
import { resolveTokens, findToken, DEFAULT_TOKENS } from '../../src/config/tokens.js';
import type { TokenConfig } from '../../src/types.js';

describe('resolveTokens', () => {
  it('returns default tokens when no overrides provided', () => {
    const tokens = resolveTokens('ethereum');
    expect(tokens).toEqual(DEFAULT_TOKENS['ethereum']);
  });

  it('returns override list when provided (ignores defaults)', () => {
    const custom: TokenConfig[] = [{ symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 }];
    const tokens = resolveTokens('ethereum', custom);
    expect(tokens).toEqual(custom);
    expect(tokens).not.toEqual(DEFAULT_TOKENS['ethereum']);
  });

  it('appends additional tokens to defaults when no override', () => {
    const extra: TokenConfig[] = [{ symbol: 'CUSTOM', address: '0x' + '1'.repeat(40), decimals: 6 }];
    const tokens = resolveTokens('arbitrum', undefined, extra);
    expect(tokens).toContainEqual(expect.objectContaining({ symbol: 'CUSTOM' }));
    // Must also contain default tokens
    expect(tokens.length).toBeGreaterThan(extra.length);
  });

  it('additional tokens are ignored when override is present', () => {
    const override:    TokenConfig[] = [{ symbol: 'A', address: '0x' + '1'.repeat(40), decimals: 6 }];
    const additional:  TokenConfig[] = [{ symbol: 'B', address: '0x' + '2'.repeat(40), decimals: 6 }];
    const tokens = resolveTokens('base', override, additional);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.symbol).toBe('A');
  });

  it('handles unknown chain gracefully (returns empty)', () => {
    const tokens = resolveTokens('unknown' as never);
    expect(tokens).toEqual([]);
  });
});

describe('findToken', () => {
  const tokens = DEFAULT_TOKENS['ethereum']!;

  it('finds a token by address (case-insensitive for EVM)', () => {
    const addr  = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    const upper = addr.toUpperCase();
    const lower = addr.toLowerCase();

    expect(findToken('ethereum', upper, tokens)?.symbol).toBe('USDT');
    expect(findToken('ethereum', lower, tokens)?.symbol).toBe('USDT');
  });

  it('returns undefined for unknown address', () => {
    expect(findToken('ethereum', '0x' + '0'.repeat(40), tokens)).toBeUndefined();
  });

  it('finds Tron token by exact address (case-sensitive)', () => {
    const tronTokens = DEFAULT_TOKENS['tron']!;
    const usdt = findToken('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', tronTokens);
    expect(usdt?.symbol).toBe('USDT');
  });
});
