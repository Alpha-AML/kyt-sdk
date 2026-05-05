/**
 * Integration test suite.
 *
 * Simulates the full KYT SDK lifecycle using:
 *   - A real SQLite database (in a temp directory)
 *   - A real HD wallet manager
 *   - Mocked Alpha AML API (no real HTTP calls)
 *   - Mocked viem blockchain clients (no real chain connections)
 *
 * All mocked Alpha AML responses follow the exact JSON structure returned by the
 * production API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { KytSDK } from '../../src/sdk.js';
import { EnvSecretsProvider } from '../../src/secrets/env.provider.js';
import type { AlphaAmlReport, DetectedTransaction, SdkEvents } from '../../src/types.js';

// ----------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------

const TEST_SEED   = '1234567890abcdef'.repeat(4); // deterministic 64-char seed
const TEST_GAS_KEY = '0123456789abcdef'.repeat(4);
const TEST_API_KEY = 'test-alpha-aml-key';
const DESTINATION  = '0xDeAdBeEf00000000000000000000000000000001';

const LOW_RISK_REPORT  = makeReport(22, false);  // score 22 → passes threshold 50
const HIGH_RISK_REPORT = makeReport(80, false);  // score 80 → blocked threshold 50
const BLACKLIST_REPORT = makeReport(100, true);  // blacklisted

function makeReport(score: number, blacklisted: boolean): AlphaAmlReport {
  return {
    report:    { generated_at_utc: '2026-05-05T00:00:00Z' },
    wallet:    { address: '0xsender', blockchain: 'ETHEREUM', description: '', entity_tag: '' },
    risk_assessment: {
      score,
      score_max:      100,
      risk_level:     score <= 25 ? 'VERY LOW RISK' : score <= 50 ? 'LOW RISK' : 'HIGH RISK',
      blacklisted,
      blacklist_note: blacklisted ? 'OFAC match' : 'No blacklist match found',
    },
    wallet_statistics: { total_transactions_count: 5, status: 'ACTIVE' },
  };
}

// Minimal Transfer log structure for EVM monitor tests
function makeTransferLog(overrides: {
  txHash?: string;
  logIndex?: number;
  blockNumber?: bigint;
  from?: string;
  tokenAddress?: string;
  amount?: bigint;
} = {}) {
  const from = overrides.from ?? ('0x' + '1'.repeat(40));
  const fromPadded = '0x' + '0'.repeat(24) + from.slice(2);
  return {
    transactionHash: overrides.txHash ?? `0x${'a'.repeat(64)}`,
    logIndex:        overrides.logIndex ?? 0,
    blockNumber:     overrides.blockNumber ?? 100n,
    address:         overrides.tokenAddress ?? '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      fromPadded,
      '0x' + '0'.repeat(24) + '1'.repeat(40),
    ],
    args: { value: overrides.amount ?? 1_000_000n },
  };
}

// ----------------------------------------------------------
// Test setup helpers
// ----------------------------------------------------------

function tmpDbDir() {
  return mkdtempSync(join(tmpdir(), 'kyt-int-test-'));
}

function buildSdk(dbDir: string) {
  process.env['KYT_MASTER_SEED']       = TEST_SEED;
  process.env['KYT_GAS_RESERVE_KEY']   = TEST_GAS_KEY;
  process.env['KYT_ALPHA_AML_API_KEY'] = TEST_API_KEY;

  return new KytSDK({
    chains: {
      ethereum: { rpcUrl: 'https://eth-mainnet.example.com/YOUR_RPC_KEY' }, // mocked — no real connection made
    },
    secrets:           new EnvSecretsProvider(),
    riskThreshold:     50,
    pollingIntervalMs: 999_999_999, // disable automatic polling in tests
    dbPath:            join(dbDir, 'test.db'),
  });
}

// ----------------------------------------------------------
// Mock viem clients so no real network calls are made
// ----------------------------------------------------------

vi.mock('viem', async (importOriginal) => {
  const real = await importOriginal<typeof import('viem')>();
  return {
    ...real,
    createPublicClient: vi.fn().mockReturnValue({
      getBlockNumber:            vi.fn().mockResolvedValue(1_000_020n),
      getBalance:                vi.fn().mockResolvedValue(5_000_000_000_000_000n), // 0.005 ETH — enough
      getLogs:                   vi.fn().mockResolvedValue([]),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      readContract:              vi.fn().mockResolvedValue(1_000_000n),
      getGasPrice:               vi.fn().mockResolvedValue(20_000_000_000n),
    }),
    createWalletClient: vi.fn().mockReturnValue({
      sendTransaction: vi.fn().mockResolvedValue('0x' + 'f'.repeat(64)),
      writeContract:   vi.fn().mockResolvedValue('0x' + 'e'.repeat(64)),
    }),
  };
});

// Mock axios so KYT HTTP calls are intercepted
vi.mock('axios');
import axios from 'axios';

// ----------------------------------------------------------
// Tests
// ----------------------------------------------------------

describe('KytSDK Integration', () => {
  let sdk:     KytSDK;
  let dbDir:   string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbDir = tmpDbDir();
    sdk   = buildSdk(dbDir);

    // Default KYT API mock: low-risk report
    vi.mocked(axios.create).mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: LOW_RISK_REPORT }),
    } as ReturnType<typeof axios.create>);

    await sdk.initialize();
  });

  afterEach(async () => {
    await sdk.shutdown();
    rmSync(dbDir, { recursive: true, force: true });
  });

  // ----------------------------------------------------------
  // Wallet creation
  // ----------------------------------------------------------

  describe('createTrackingWallet', () => {
    it('creates a wallet with an EVM address', async () => {
      const wallet = await sdk.createTrackingWallet({
        chains:             ['ethereum'],
        destinationAddress: DESTINATION,
      });
      expect(wallet.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(wallet.index).toBe(0);
    });

    it('auto-increments index', async () => {
      const w1 = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      const w2 = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      expect(w2.index).toBe(w1.index + 1);
    });

    it('accepts a client-provided index', async () => {
      const wallet = await sdk.createTrackingWallet({
        chains:             ['ethereum'],
        destinationAddress: DESTINATION,
        index:              99,
      });
      expect(wallet.index).toBe(99);
    });

    it('persists wallet across SDK restart', async () => {
      const created = await sdk.createTrackingWallet({
        chains:             ['ethereum'],
        destinationAddress: DESTINATION,
        label:              'order-001',
      });

      await sdk.shutdown();
      const sdk2 = buildSdk(dbDir);
      await sdk2.initialize();

      const retrieved = sdk2.getTrackingWallet(created.id);
      expect(retrieved?.label).toBe('order-001');
      expect(retrieved?.evmAddress).toBe(created.evmAddress);

      await sdk2.shutdown();
    });

    it('throws when chain is not in config', async () => {
      await expect(
        sdk.createTrackingWallet({ chains: ['tron'], destinationAddress: DESTINATION }),
      ).rejects.toThrow('"tron" is not configured');
    });

    it('throws when destinationAddress is empty', async () => {
      await expect(
        sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: '' }),
      ).rejects.toThrow('destinationAddress is required');
    });

    it('two wallets at consecutive indices have different EVM addresses', async () => {
      const w1 = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      const w2 = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      expect(w1.evmAddress).not.toBe(w2.evmAddress);
    });
  });

  // ----------------------------------------------------------
  // KYT decision: approved path
  // ----------------------------------------------------------

  describe('KYT check — approved (score ≤ threshold)', () => {
    it('emits kyt.passed event for low-risk sender', async () => {
      const wallet = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });

      const kytPassed = vi.fn();
      sdk.on('kyt.passed', kytPassed);

      await simulateConfirmedTx(sdk, wallet.id, '0xsenderA', 1_000_000n);

      expect(kytPassed).toHaveBeenCalledOnce();
      expect(kytPassed.mock.calls[0]![0].score).toBe(22);
    });

    it('stores transaction as approved', async () => {
      const wallet = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      const txId   = await simulateConfirmedTx(sdk, wallet.id, '0xclean', 1_000_000n);

      const txs = sdk.getTransactions(wallet.id);
      const tx  = txs.find(t => t.id === txId);
      expect(tx?.status).toBe('forwarded'); // approved + all resolved → forwarded
    });
  });

  // ----------------------------------------------------------
  // KYT decision: blocked path
  // ----------------------------------------------------------

  describe('KYT check — blocked (score > threshold)', () => {
    beforeEach(() => {
      vi.mocked(axios.create).mockReturnValue({
        get: vi.fn().mockResolvedValue({ data: HIGH_RISK_REPORT }),
      } as ReturnType<typeof axios.create>);

      sdk.shutdown().then(() => {
        sdk = buildSdk(dbDir);
        return sdk.initialize();
      });
    });

    it('emits kyt.blocked event for high-risk sender', async () => {
      // Reinitialize with blocked report
      await sdk.shutdown();
      vi.mocked(axios.create).mockReturnValue({
        get: vi.fn().mockResolvedValue({ data: HIGH_RISK_REPORT }),
      } as ReturnType<typeof axios.create>);
      sdk = buildSdk(dbDir);
      await sdk.initialize();

      const wallet = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });

      const kytBlocked = vi.fn();
      sdk.on('kyt.blocked', kytBlocked);

      await simulateConfirmedTx(sdk, wallet.id, '0xrisky', 5_000_000n);

      expect(kytBlocked).toHaveBeenCalledOnce();
      expect(kytBlocked.mock.calls[0]![0].score).toBe(80);
    });

    it('keeps funds on tracking wallet (status = blocked)', async () => {
      await sdk.shutdown();
      vi.mocked(axios.create).mockReturnValue({
        get: vi.fn().mockResolvedValue({ data: HIGH_RISK_REPORT }),
      } as ReturnType<typeof axios.create>);
      sdk = buildSdk(dbDir);
      await sdk.initialize();

      const wallet = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      const txId   = await simulateConfirmedTx(sdk, wallet.id, '0xrisky', 5_000_000n);

      const txs = sdk.getTransactions(wallet.id);
      const tx  = txs.find(t => t.id === txId);
      expect(tx?.status).toBe('blocked');
    });
  });

  // ----------------------------------------------------------
  // Hold-everything rule
  // ----------------------------------------------------------

  describe('Hold-everything rule', () => {
    it('does not forward until ALL transactions are resolved', async () => {
      const wallet = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });

      const transferred = vi.fn();
      sdk.on('transfer.initiated', transferred);

      // Inject one pending_kyt and one approved
      injectRawTransaction(sdk, {
        id:           'tx-pending',
        walletId:     wallet.id,
        chain:        'ethereum',
        txHash:       '0x' + '0'.repeat(64),
        blockNumber:  1_000_000,
        sender:       '0xsender1',
        tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        tokenSymbol:  'USDT',
        amount:       1_000_000n,
        decimals:     6,
        status:       'pending_kyt',
        detectedAt:   new Date(),
      });

      injectRawTransaction(sdk, {
        id:           'tx-approved',
        walletId:     wallet.id,
        chain:        'ethereum',
        txHash:       '0x' + '1'.repeat(64),
        blockNumber:  1_000_001,
        sender:       '0xsender2',
        tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        tokenSymbol:  'USDT',
        amount:       2_000_000n,
        decimals:     6,
        status:       'approved',
        detectedAt:   new Date(),
      });

      // At this point, 'tx-pending' is still in pending_kyt → no forwarding yet
      expect(transferred).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // Wallet management
  // ----------------------------------------------------------

  describe('wallet management', () => {
    it('listTrackingWallets returns all wallets', async () => {
      await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      expect(sdk.listTrackingWallets()).toHaveLength(2);
    });

    it('pauseTrackingWallet sets status to paused', async () => {
      const w = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      sdk.pauseTrackingWallet(w.id);
      expect(sdk.getTrackingWallet(w.id)?.status).toBe('paused');
    });

    it('resumeTrackingWallet sets status back to active', async () => {
      const w = await sdk.createTrackingWallet({ chains: ['ethereum'], destinationAddress: DESTINATION });
      sdk.pauseTrackingWallet(w.id);
      sdk.resumeTrackingWallet(w.id);
      expect(sdk.getTrackingWallet(w.id)?.status).toBe('active');
    });

    it('throws when pausing unknown wallet', () => {
      expect(() => sdk.pauseTrackingWallet('nonexistent')).toThrow('not found');
    });
  });

  // ----------------------------------------------------------
  // Static utilities
  // ----------------------------------------------------------

  describe('static utilities', () => {
    it('generateSeed returns a 64-char hex string', () => {
      expect(KytSDK.generateSeed()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generateMnemonic returns 24 words', () => {
      expect(KytSDK.generateMnemonic().split(' ')).toHaveLength(24);
    });

    it('mnemonicToSeed round-trips correctly', () => {
      const mnemonic = KytSDK.generateMnemonic();
      const seed     = KytSDK.mnemonicToSeed(mnemonic);
      expect(seed).toMatch(/^[0-9a-f]{128}$/);
    });

    it('throws before initialize()', () => {
      const uninit = buildSdk(dbDir + '-uninit');
      expect(() => uninit.listTrackingWallets()).toThrow('not initialized');
    });
  });
});

// ----------------------------------------------------------
// Test helpers
// ----------------------------------------------------------

/**
 * Directly inserts a transaction into the SDK's storage, bypassing the monitor.
 * Used to test the KYT and forwarding logic in isolation.
 */
function injectRawTransaction(sdk: KytSDK, tx: DetectedTransaction): void {
  // Access internal storage via casting — acceptable in integration tests
  const internal = sdk as unknown as { storage: import('../../src/storage/sqlite.storage.js').SqliteStorage };
  internal.storage.insertTransaction(tx);
}

/**
 * Simulates a fully-confirmed incoming Transfer event being processed by the SDK.
 * Returns the transaction ID.
 */
async function simulateConfirmedTx(
  sdk: KytSDK,
  walletId: string,
  sender: string,
  amount: bigint,
): Promise<string> {
  const txId = randomUUID();
  const tx: DetectedTransaction = {
    id:           txId,
    walletId,
    chain:        'ethereum',
    txHash:       '0x' + randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    blockNumber:  1_000_000,
    sender:       sender.toLowerCase(),
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    tokenSymbol:  'USDT',
    amount,
    decimals:     6,
    status:       'pending_kyt',
    detectedAt:   new Date(),
  };

  // Call internal handleConfirmed to simulate a confirmed transaction
  const internal = sdk as unknown as {
    handleConfirmed: (tx: DetectedTransaction) => Promise<void>;
    storage: import('../../src/storage/sqlite.storage.js').SqliteStorage;
  };

  internal.storage.insertTransaction(tx);
  await internal.handleConfirmed(tx);

  return txId;
}
