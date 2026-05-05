import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteStorage } from '../../src/storage/sqlite.storage.js';
import type { TrackingWallet, DetectedTransaction } from '../../src/types.js';

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyt-test-'));
  return join(dir, 'test.db');
}

function makeWallet(overrides: Partial<TrackingWallet> = {}): TrackingWallet {
  return {
    id:                 randomUUID(),
    index:              Math.floor(Math.random() * 1_000_000),
    evmAddress:         '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
    chains:             ['ethereum'],
    destinationAddress: '0x000000000000000000000000000000000000dEaD',
    riskThreshold:      50,
    pollingIntervalMs:  60_000,
    status:             'active',
    createdAt:          new Date(),
    ...overrides,
  };
}

function makeTx(walletId: string, overrides: Partial<DetectedTransaction> = {}): DetectedTransaction {
  return {
    id:           randomUUID(),
    walletId,
    chain:        'ethereum',
    txHash:       `0x${'a'.repeat(64)}`,
    blockNumber:  1_000_000,
    sender:       '0x' + '1'.repeat(40),
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    tokenSymbol:  'USDT',
    amount:       1_000_000n,
    decimals:     6,
    status:       'pending_confirmations',
    detectedAt:   new Date(),
    ...overrides,
  };
}

describe('SqliteStorage', () => {
  let storage: SqliteStorage;
  let dbPath:  string;

  beforeEach(() => {
    dbPath  = tmpDb();
    storage = new SqliteStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
  });

  describe('tracking wallets', () => {
    it('upserts and retrieves a wallet', () => {
      const w = makeWallet();
      storage.upsertWallet(w);
      expect(storage.getWallet(w.id)).toMatchObject({ id: w.id, index: w.index });
    });

    it('returns undefined for unknown wallet', () => {
      expect(storage.getWallet('does-not-exist')).toBeUndefined();
    });

    it('lists all wallets ordered by index', () => {
      const w1 = makeWallet({ index: 2 });
      const w2 = makeWallet({ index: 0 });
      const w3 = makeWallet({ index: 1 });
      storage.upsertWallet(w1);
      storage.upsertWallet(w2);
      storage.upsertWallet(w3);
      const list = storage.listWallets();
      expect(list.map(w => w.index)).toEqual([0, 1, 2]);
    });

    it('listActiveWallets excludes paused', () => {
      const active = makeWallet({ status: 'active' });
      const paused = makeWallet({ status: 'paused', index: active.index + 1 });
      storage.upsertWallet(active);
      storage.upsertWallet(paused);
      const list = storage.listActiveWallets();
      expect(list.every(w => w.status === 'active')).toBe(true);
    });

    it('maxWalletIndex returns -1 when no wallets exist', () => {
      expect(storage.maxWalletIndex()).toBe(-1);
    });

    it('maxWalletIndex returns the highest index', () => {
      storage.upsertWallet(makeWallet({ index: 5 }));
      storage.upsertWallet(makeWallet({ index: 12 }));
      storage.upsertWallet(makeWallet({ index: 3 }));
      expect(storage.maxWalletIndex()).toBe(12);
    });

    it('upsert updates status without creating duplicate', () => {
      const w = makeWallet();
      storage.upsertWallet(w);
      storage.upsertWallet({ ...w, status: 'paused' });
      const wallets = storage.listWallets();
      expect(wallets).toHaveLength(1);
      expect(wallets[0]?.status).toBe('paused');
    });
  });

  describe('transactions', () => {
    let wallet: TrackingWallet;

    beforeEach(() => {
      wallet = makeWallet();
      storage.upsertWallet(wallet);
    });

    it('inserts and retrieves a transaction', () => {
      const tx = makeTx(wallet.id);
      storage.insertTransaction(tx);
      const result = storage.getTransaction(tx.id);
      expect(result).toMatchObject({ id: tx.id, status: 'pending_confirmations' });
    });

    it('stores BigInt amount correctly', () => {
      const tx = makeTx(wallet.id, { amount: 999_999_999_999_999n });
      storage.insertTransaction(tx);
      expect(storage.getTransaction(tx.id)?.amount).toBe(999_999_999_999_999n);
    });

    it('INSERT OR IGNORE on duplicate id', () => {
      const tx = makeTx(wallet.id);
      storage.insertTransaction(tx);
      storage.insertTransaction(tx); // duplicate — should not throw
      expect(storage.listTransactions(wallet.id)).toHaveLength(1);
    });

    it('updateTransactionStatus transitions correctly', () => {
      const tx = makeTx(wallet.id);
      storage.insertTransaction(tx);
      storage.updateTransactionStatus(tx.id, 'approved', { kytScore: 22 });
      const updated = storage.getTransaction(tx.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.kytScore).toBe(22);
    });

    it('listPendingTransactions excludes terminal states', () => {
      const pending  = makeTx(wallet.id, { id: 'p1', status: 'pending_confirmations' });
      const approved = makeTx(wallet.id, { id: 'a1', status: 'approved' });
      const blocked  = makeTx(wallet.id, { id: 'b1', status: 'blocked' });
      storage.insertTransaction(pending);
      storage.insertTransaction(approved);
      storage.insertTransaction(blocked);
      const result = storage.listPendingTransactions(wallet.id);
      // approved is not in terminal for pending check (excluded only forwarded+blocked)
      expect(result.map(t => t.id)).toContain('p1');
      expect(result.map(t => t.id)).toContain('a1');
      expect(result.map(t => t.id)).not.toContain('b1');
    });

    it('allTransactionsResolved returns true when no pending', () => {
      storage.insertTransaction(makeTx(wallet.id, { status: 'approved' }));
      storage.insertTransaction(makeTx(wallet.id, { id: 'b2', status: 'blocked' }));
      expect(storage.allTransactionsResolved(wallet.id)).toBe(true);
    });

    it('allTransactionsResolved returns false with pending_kyt', () => {
      storage.insertTransaction(makeTx(wallet.id, { status: 'pending_kyt' }));
      expect(storage.allTransactionsResolved(wallet.id)).toBe(false);
    });

    it('markTransactionsForwarded marks ids as forwarded', () => {
      const tx1 = makeTx(wallet.id, { id: 'f1', status: 'approved' });
      const tx2 = makeTx(wallet.id, { id: 'f2', status: 'approved' });
      storage.insertTransaction(tx1);
      storage.insertTransaction(tx2);
      storage.markTransactionsForwarded(['f1', 'f2']);
      expect(storage.getTransaction('f1')?.status).toBe('forwarded');
      expect(storage.getTransaction('f2')?.status).toBe('forwarded');
    });

    it('listApprovedPendingForward only returns approved', () => {
      storage.insertTransaction(makeTx(wallet.id, { id: 'app', status: 'approved' }));
      storage.insertTransaction(makeTx(wallet.id, { id: 'blk', status: 'blocked' }));
      storage.insertTransaction(makeTx(wallet.id, { id: 'fwd', status: 'forwarded' }));
      const result = storage.listApprovedPendingForward(wallet.id);
      expect(result.map(t => t.id)).toEqual(['app']);
    });
  });

  describe('monitor state', () => {
    let walletId: string;

    beforeEach(() => {
      const w = makeWallet();
      storage.upsertWallet(w);
      walletId = w.id;
    });

    it('returns 0 for unknown wallet/chain', () => {
      expect(storage.getLastBlock(walletId, 'ethereum')).toBe(0);
    });

    it('stores and retrieves last block', () => {
      storage.setLastBlock(walletId, 'ethereum', 19_000_000);
      expect(storage.getLastBlock(walletId, 'ethereum')).toBe(19_000_000);
    });

    it('updates last block on conflict', () => {
      storage.setLastBlock(walletId, 'base', 5_000_000);
      storage.setLastBlock(walletId, 'base', 5_001_000);
      expect(storage.getLastBlock(walletId, 'base')).toBe(5_001_000);
    });

    it('tracks each chain independently', () => {
      storage.setLastBlock(walletId, 'ethereum', 100);
      storage.setLastBlock(walletId, 'arbitrum', 200);
      expect(storage.getLastBlock(walletId, 'ethereum')).toBe(100);
      expect(storage.getLastBlock(walletId, 'arbitrum')).toBe(200);
    });
  });
});
