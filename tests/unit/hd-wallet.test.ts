import { describe, it, expect } from 'vitest';
import { HdWalletManager } from '../../src/wallet/hd-wallet.js';

const TEST_SEED = 'a'.repeat(64); // deterministic 32-byte seed for tests

describe('HdWalletManager', () => {
  describe('constructor', () => {
    it('accepts a 64-char hex seed', () => {
      expect(() => new HdWalletManager(TEST_SEED)).not.toThrow();
    });

    it('rejects seeds shorter than 64 chars', () => {
      expect(() => new HdWalletManager('deadbeef')).toThrow('at least 64');
    });

    it('rejects non-hex input', () => {
      expect(() => new HdWalletManager('z'.repeat(64))).toThrow();
    });
  });

  describe('deriveEvm', () => {
    const mgr = new HdWalletManager(TEST_SEED);

    it('returns a valid 0x EVM address', () => {
      const { address } = mgr.deriveEvm(0);
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('returns a 0x-prefixed private key', () => {
      const { privateKey } = mgr.deriveEvm(0);
      expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });

    it('produces deterministic results', () => {
      const a = mgr.deriveEvm(5);
      const b = mgr.deriveEvm(5);
      expect(a.address).toBe(b.address);
      expect(a.privateKey).toBe(b.privateKey);
    });

    it('produces different wallets for different indices', () => {
      const a = mgr.deriveEvm(0);
      const b = mgr.deriveEvm(1);
      expect(a.address).not.toBe(b.address);
      expect(a.privateKey).not.toBe(b.privateKey);
    });

    it('different seeds produce different addresses', () => {
      const other = new HdWalletManager('b'.repeat(64));
      expect(mgr.deriveEvm(0).address).not.toBe(other.deriveEvm(0).address);
    });

    it('rejects negative index', () => {
      expect(() => mgr.deriveEvm(-1)).toThrow();
    });

    it('rejects non-integer index', () => {
      expect(() => mgr.deriveEvm(1.5)).toThrow();
    });
  });

  describe('deriveTron', () => {
    const mgr = new HdWalletManager(TEST_SEED);

    it('returns a valid Tron Base58 address starting with T', () => {
      const { address } = mgr.deriveTron(0);
      expect(address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    });

    it('returns a 64-char hex private key (no 0x)', () => {
      const { privateKey } = mgr.deriveTron(0);
      expect(privateKey).toMatch(/^[0-9a-fA-F]{64}$/);
    });

    it('produces deterministic results', () => {
      const a = mgr.deriveTron(3);
      const b = mgr.deriveTron(3);
      expect(a.address).toBe(b.address);
    });

    it('EVM and Tron wallets at same index have different keys', () => {
      const evm  = mgr.deriveEvm(0);
      const tron = mgr.deriveTron(0);
      // Different derivation paths mean different keys
      expect(evm.privateKey.replace('0x', '')).not.toBe(tron.privateKey);
    });
  });

  describe('static utilities', () => {
    it('generateSeed returns 64 hex chars', () => {
      const seed = HdWalletManager.generateSeed();
      expect(seed).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generateSeed produces unique values', () => {
      expect(HdWalletManager.generateSeed()).not.toBe(HdWalletManager.generateSeed());
    });

    it('generateMnemonic returns 24 words', () => {
      const mnemonic = HdWalletManager.generateMnemonic();
      expect(mnemonic.split(' ')).toHaveLength(24);
    });

    it('mnemonicToSeed produces a 128-char hex string from a valid mnemonic', () => {
      const mnemonic = HdWalletManager.generateMnemonic();
      const seed     = HdWalletManager.mnemonicToSeed(mnemonic);
      expect(seed).toMatch(/^[0-9a-f]{128}$/);
    });

    it('mnemonicToSeed throws on invalid mnemonic', () => {
      expect(() => HdWalletManager.mnemonicToSeed('invalid mnemonic words here')).toThrow('Invalid BIP39');
    });

    it('mnemonicToSeed is deterministic', () => {
      const mnemonic = HdWalletManager.generateMnemonic();
      expect(HdWalletManager.mnemonicToSeed(mnemonic)).toBe(HdWalletManager.mnemonicToSeed(mnemonic));
    });

    it('same mnemonic with different passphrase gives different seed', () => {
      const mnemonic = HdWalletManager.generateMnemonic();
      expect(HdWalletManager.mnemonicToSeed(mnemonic, 'pass1')).not.toBe(
        HdWalletManager.mnemonicToSeed(mnemonic, 'pass2'),
      );
    });
  });
});
