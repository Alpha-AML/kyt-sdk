/**
 * manual_transfer.ts
 *
 * Transfer all stablecoin balances from a buffer wallet to a destination address.
 * Use this for recovery or manual fund movement.
 *
 * Usage:
 *   npm run manual:transfer -- --from 0x<buffer_wallet> --to 0x<destination> --chain arbitrum
 *   npm run manual:transfer -- --list
 *
 * Required:
 *   --from    On-chain address of the buffer wallet (source)
 *   --to      Destination address to send funds to
 *   --chain   Chain: ethereum | ethereum-sepolia | arbitrum | arbitrum-sepolia | base | bsc | tron
 *
 * Flags:
 *   --list    Print all buffer wallets in the DB and exit
 */

import 'dotenv/config';
import { KytSDK, VaultSecretsProvider } from '../src/index.js';
import { DEFAULT_TOKENS }               from '../src/config/tokens.js';
import { CHAIN_META }                   from '../src/config/chains.js';
import { postWebhook }                  from './lib/payment_webhook.js';
import type { SupportedChain }          from '../src/types.js';
import { privateKeyToAccount }          from 'viem/accounts';
import { secp256k1 }                    from '@noble/curves/secp256k1';
import { keccak_256 }                   from '@noble/hashes/sha3';
import { sha256 }                       from '@noble/hashes/sha256';
import { base58 }                       from '@scure/base';

// ----------------------------------------------------------
// 1. Parse CLI args
// ----------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);

  let from  = '';
  let to    = '';
  let chain: SupportedChain | '' = '';
  let list  = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from'  && argv[i+1]) { from  = argv[++i]!; }
    if (argv[i] === '--to'    && argv[i+1]) { to    = argv[++i]!; }
    if (argv[i] === '--chain' && argv[i+1]) { chain = argv[++i]! as SupportedChain; }
    if (argv[i] === '--list')               { list  = true; }
  }

  if (!list && !from) {
    console.error('ERROR: --from <buffer_wallet_address> is required');
    console.error('       Use --list to see all buffer wallets');
    process.exit(1);
  }

  if (!list && !to) {
    console.error('ERROR: --to <destination_address> is required');
    process.exit(1);
  }

  if (!list && !chain) {
    console.error('ERROR: --chain is required');
    console.error('       Supported: ethereum | ethereum-sepolia | arbitrum | arbitrum-sepolia | base | bsc | tron');
    process.exit(1);
  }

  return { from, to, chain: chain as SupportedChain, list };
}

const args = parseArgs();

// ----------------------------------------------------------
// 2. SDK init
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
    ethereum:           { rpcUrl: process.env['ETH_RPC_URL']          ?? '' },
    'ethereum-sepolia': { rpcUrl: process.env['ETH_SEPOLIA_RPC_URL']  ?? '' },
    arbitrum:           { rpcUrl: process.env['ARB_RPC_URL']          ?? '' },
    'arbitrum-sepolia': { rpcUrl: process.env['ARB_SEPOLIA_RPC_URL']  ?? '' },
    base:               { rpcUrl: process.env['BASE_RPC_URL']         ?? '' },
    bsc:                { rpcUrl: process.env['BSC_RPC_URL']          ?? '' },
    tron:               { rpcUrl: process.env['TRON_RPC_URL'] ?? 'https://api.trongrid.io',
                          tronGridApiKey: process.env['TRON_API_KEY'] },
  },
  secrets,
  dbPath: process.env['KYT_DB_PATH'] ?? './kyt-sdk.db',
});

await sdk.initialize();

// ----------------------------------------------------------
// 3. List mode
// ----------------------------------------------------------

if (args.list) {
  const wallets = sdk.listTrackingWallets();

  if (wallets.length === 0) {
    console.log('\nNo buffer wallets in database.\n');
  } else {
    console.log(`\n${'─'.repeat(110)}`);
    console.log(
      'Index'.padEnd(7) +
      'Status'.padEnd(10) +
      'Chain'.padEnd(12) +
      'EVM Address'.padEnd(44) +
      'Label',
    );
    console.log(`${'─'.repeat(110)}`);
    for (const w of wallets) {
      console.log(
        String(w.index).padEnd(7) +
        w.status.padEnd(10) +
        w.chains.join(',').padEnd(12) +
        (w.evmAddress ?? '—').padEnd(44) +
        (w.label ?? '—'),
      );
    }
    console.log(`${'─'.repeat(110)}`);
    console.log(`  ${wallets.length} wallet(s)\n`);
  }

  await sdk.shutdown();
  process.exit(0);
}

// ----------------------------------------------------------
// 4. Find wallet by address
// ----------------------------------------------------------

const allWallets = sdk.listTrackingWallets();
const wallet = allWallets.find(w => {
  const addr = args.chain === 'tron' ? w.tronAddress : w.evmAddress;
  return addr?.toLowerCase() === args.from.toLowerCase();
});

if (!wallet) {
  console.error(`ERROR: No buffer wallet with address "${args.from}" found on ${args.chain}.`);
  console.error('       Use --list to see all wallets.');
  process.exit(1);
}

// ----------------------------------------------------------
// 5. Gas wallet helpers
// ----------------------------------------------------------

function gasKeyToTronAddress(hexKey: string): string {
  const privBytes = Buffer.from(hexKey, 'hex');
  const pubKey    = secp256k1.getPublicKey(privBytes, false);
  const hash      = keccak_256(pubKey.slice(1));
  const raw       = new Uint8Array(21);
  raw[0] = 0x41;
  raw.set(hash.slice(-20), 1);
  const checksum  = sha256(sha256(raw)).slice(0, 4);
  const full      = new Uint8Array(25);
  full.set(raw, 0);
  full.set(checksum, 21);
  return base58.encode(full);
}

async function resolveGasWalletAddress(chain: SupportedChain): Promise<string | null> {
  const rawKey = await secrets.getGasReservePrivateKey().catch(() => null);
  if (!rawKey) return null;
  if (chain === 'tron') return gasKeyToTronAddress(rawKey.replace(/^0x/, ''));
  const evmKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
  return privateKeyToAccount(evmKey).address;
}

async function sweepNativeToGasWallet(gasAddr: string): Promise<void> {
  const chainMeta = CHAIN_META[args.chain];
  console.log(`\n  Returning leftover ${chainMeta.nativeSymbol} to gas reserve (${gasAddr})...`);
  try {
    const result = await sdk.manualTransfer({
      walletIndex:        wallet.index,
      chain:              args.chain,
      destinationAddress: gasAddr,
    });
    console.log(`  Gas swept — ${result.amount} returned — tx ${result.txHash}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Nothing to sweep (${msg})`);
  }
}

// ----------------------------------------------------------
// 6. Transfer
// ----------------------------------------------------------

const tokens = DEFAULT_TOKENS[args.chain] ?? [];
const meta   = CHAIN_META[args.chain];

function fmtToken(amount: bigint, decimals: number, symbol: string): string {
  const div   = BigInt(10 ** decimals);
  const whole = amount / div;
  const frac  = (amount % div).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac} ${symbol}`;
}

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║           Manual Transfer                                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');
console.log(`  From  : ${args.from}`);
console.log(`  To    : ${args.to}`);
console.log(`  Chain : ${meta.name}`);
console.log('');

let transferred = 0;
const transferErrors: Array<{ symbol: string; msg: string }> = [];

for (const token of tokens) {
  try {
    const result = await sdk.manualTransfer({
      walletIndex:        wallet.index,
      chain:              args.chain,
      destinationAddress: args.to,
      tokenAddress:       token.address,
    });
    console.log(`  ✓ ${fmtToken(result.amount, token.decimals, token.symbol)} → ${args.to}`);
    console.log(`    tx: ${result.txHash}`);
    transferred++;
    void postWebhook({
      event:   'manual_transfer_completed',
      tx_hash: result.txHash,
      amount:  fmtToken(result.amount, token.decimals, token.symbol),
      token:   token.symbol,
      from:    args.from,
      to:      args.to,
      chain:   args.chain,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    if (lower.includes('zero') || lower.includes('no balance') || lower.includes('transfer amount is zero')) {
      console.log(`  — ${token.symbol}: no balance, skipping`);
    } else {
      // Real failure — funds did NOT move, still on buffer wallet
      console.error(`  ✗ ${token.symbol}: ${msg}`);
      transferErrors.push({ symbol: token.symbol, msg });
      void postWebhook({
        event:      'error',
        error_type: 'manual_transfer_failed',
        token:      token.symbol,
        message:    msg,
        from:       args.from,
        to:         args.to,
        chain:      args.chain,
      });
    }
  }
}

console.log('');

if (transferErrors.length > 0) {
  const isGasError = transferErrors.some(e => {
    const l = e.msg.toLowerCase();
    return l.includes('gas') || l.includes('insufficient funds') || l.includes('intrinsic');
  });

  console.error('╔══ ACTION REQUIRED ══════════════════════════════════════════════╗');
  console.error('  Transfer FAILED — funds are SAFE on the buffer wallet');
  console.error(`  Buffer wallet : ${args.from}`);
  console.error('');
  for (const e of transferErrors) {
    console.error(`  ${e.symbol} error : ${e.msg}`);
  }
  if (isGasError) {
    console.error('');
    console.error(`  CAUSE : Buffer wallet has insufficient native token for gas`);
    console.error(`  FIX   : Send ${meta.nativeSymbol} to the buffer wallet address above`);
  }
  console.error('');
  console.error('  Retry after fixing:');
  console.error(`    npm run manual:transfer -- --from ${args.from} --to ${args.to} --chain ${args.chain}`);
  console.error('╚═════════════════════════════════════════════════════════════════╝');
  process.exit(1);
}

if (transferred === 0) {
  console.log(`  No stablecoin balances found on this wallet for ${meta.name}.`);
} else {
  console.log(`  Done — ${transferred} token(s) transferred.`);
}

if (transferErrors.length === 0) {
  sdk.pauseTrackingWallet(wallet.id);
  console.log(`  Wallet marked as paused — will not be re-processed on next run.`);
  const gasAddr = await resolveGasWalletAddress(args.chain);
  if (gasAddr) await sweepNativeToGasWallet(gasAddr);
}
console.log('');

await sdk.shutdown();
