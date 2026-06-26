/**
 * init_gas_wallets.ts
 *
 * Run ONCE before going live to verify your gas reserve wallet is set up.
 *
 * What it does:
 *   1. Initialises the SDK (same as basic.ts).
 *   2. Derives the gas reserve wallet public address for EVM and Tron.
 *   3. Prints each address + minimum funding required per chain.
 *
 * Usage:
 *   npm run init:gas
 *
 * After running, send native tokens to each printed address:
 *   EVM address  →  ETH on Ethereum / Arbitrum / Base,  BNB on BSC
 *   Tron address →  TRX on Tron
 *
 * The SDK GasManager tops up tracking wallets automatically from these
 * addresses whenever their balance drops below the configured minimum.
 */
import 'dotenv/config';
import Database                       from 'better-sqlite3';
import { privateKeyToAccount }        from 'viem/accounts';
import { secp256k1 }                  from '@noble/curves/secp256k1';
import { keccak_256 }                 from '@noble/hashes/sha3';
import { sha256 }                     from '@noble/hashes/sha256';
import { base58 }                     from '@scure/base';
import { KytSDK, VaultSecretsProvider } from '../src/index.js';
import { CHAIN_META, EVM_CHAINS }     from '../src/config/chains.js';
import { postWebhook }                from './lib/payment_webhook.js';
import type { SupportedChain }        from '../src/types.js';

// ----------------------------------------------------------
// 1. SDK init — same pattern as basic.ts
// ----------------------------------------------------------

const secrets = new VaultSecretsProvider({
    addr:  process.env['VAULT_ADDR'],
    token: process.env['VAULT_TOKEN'],
    path:  process.env['VAULT_PATH'] ?? 'kyt-sdk/test',
    fields: {
      masterSeed:     'KYT_MASTER_SEED',
      gasReserveKey:  'KYT_GAS_RESERVE_KEY',
      alphaAmlApiKey: 'KYT_ALPHA_AML_API_KEY',
      webhookSecret:  'KYT_WEBHOOK_SECRET',
    },
  });

const sdk = new KytSDK({
  chains: {
    ethereum:           { rpcUrl: process.env['ETH_RPC_URL']         ?? '' },
    'ethereum-sepolia': { rpcUrl: process.env['ETH_SEPOLIA_RPC_URL'] ?? '' },
    arbitrum:           { rpcUrl: process.env['ARB_RPC_URL']         ?? '' },
    'arbitrum-sepolia': { rpcUrl: process.env['ARB_SEPOLIA_RPC_URL'] ?? '' },
    base:               { rpcUrl: process.env['BASE_RPC_URL']        ?? '' },
    bsc:                { rpcUrl: process.env['BSC_RPC_URL']         ?? '' },
    tron:               { rpcUrl: process.env['TRON_RPC_URL'] ?? 'https://api.trongrid.io',
                          tronGridApiKey: process.env['TRON_API_KEY'] },
  },
  secrets,
});

sdk.on('error', ({ error, context }) =>
  console.error(`[ERROR] ${context}: ${error.message}`),
);

await sdk.initialize();

// ----------------------------------------------------------
// 2. Open DB and ensure gas_wallets table exists
//    (same file the SDK uses for tracking_wallets / transactions)
// ----------------------------------------------------------

const DB_PATH = process.env['KYT_DB_PATH'] ?? './kyt-sdk.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS gas_wallets (
    chain      TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

const upsertGasWallet = db.prepare<{ chain: string; address: string; created_at: number }>(`
  INSERT INTO gas_wallets (chain, address, created_at)
  VALUES (@chain, @address, @created_at)
  ON CONFLICT(chain) DO UPDATE SET address = excluded.address
`);

// ----------------------------------------------------------
// 3. Derive gas reserve wallet public addresses
// ----------------------------------------------------------

const rawKey  = await secrets.getGasReservePrivateKey();
const evmKey  = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;

const evmAddress  = privateKeyToAccount(evmKey).address;
const tronAddress = gasKeyToTronAddress(rawKey.replace(/^0x/, ''));

// ----------------------------------------------------------
// 4. Store to DB + print addresses + funding requirements
// ----------------------------------------------------------

const now = Date.now();

// Store one row per chain (EVM chains share the same address)
for (const chain of EVM_CHAINS) {
  upsertGasWallet.run({ chain, address: evmAddress, created_at: now });
}
upsertGasWallet.run({ chain: 'tron', address: tronAddress, created_at: now });

db.close();

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║           Alpha AML — Gas Wallet Setup                      ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log('EVM Gas Wallet  (one address, fund on EACH EVM chain you use)');
console.log(`  Address : ${evmAddress}\n`);
for (const chain of EVM_CHAINS) {
  const m = CHAIN_META[chain];
  console.log(
    `  ${m.name.padEnd(22)}  min ${fmt(m.defaultMinGasWei, chain)} ${m.nativeSymbol}` +
    `  /  top-up ${fmt(m.defaultTopUpWei, chain)} ${m.nativeSymbol}`,
  );
}

console.log('\nTron Gas Wallet');
console.log(`  Address : ${tronAddress}`);
const tm = CHAIN_META['tron'];
console.log(`  min ${fmt(tm.defaultMinGasWei, 'tron')} TRX  /  top-up ${fmt(tm.defaultTopUpWei, 'tron')} TRX`);

console.log(`\nAll gas wallet addresses saved to: ${DB_PATH}`);
console.log('Fund the addresses above, then run create_buffer_wallet to start accepting payments.\n');

await postWebhook({
  event:        'gas_wallet_ready',
  message:      'Please deposit native token to this address for future transactions',
  evm_address:  evmAddress,
  tron_address: tronAddress,
  chains: EVM_CHAINS.map(c => {
    const m = CHAIN_META[c];
    return {
      chain:          c,
      name:           m.name,
      native_symbol:  m.nativeSymbol,
      min_amount:     fmt(m.defaultMinGasWei, c),
      topup_amount:   fmt(m.defaultTopUpWei, c),
    };
  }),
});

await sdk.shutdown();

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function fmt(wei: bigint, chain: SupportedChain): string {
  const div = chain === 'tron' ? 1_000_000n : 1_000_000_000_000_000_000n;
  const pad = chain === 'tron' ? 6 : 18;
  const whole = wei / div;
  const frac  = (wei % div).toString().padStart(pad, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function gasKeyToTronAddress(hexKey: string): string {
  const privBytes = Buffer.from(hexKey, 'hex');
  const pubKey    = secp256k1.getPublicKey(privBytes, false);
  const hash      = keccak_256(pubKey.slice(1));
  const raw       = new Uint8Array(21);
  raw[0] = 0x41;
  raw.set(hash.slice(-20), 1);
  const checksum = sha256(sha256(raw)).slice(0, 4);
  const full     = new Uint8Array(25);
  full.set(raw, 0);
  full.set(checksum, 21);
  return base58.encode(full);
}
