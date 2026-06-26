/**
 * coinspaid_withdrawal.ts  — Layer 3
 *
 * Creates Buffer Wallet 2, withdraws from CoinsPaid to it,
 * runs AML check on the CoinsPaid sender, then forwards to the destination wallet.
 * Exits automatically when complete.
 *
 * Run this after deposit-to-coinspaid.ts prints the webhook confirmation command.
 *
 * Usage:
 *   npm run cp:withdraw -- \
 *     --coinspaid-address 0x92F31... \
 *     --destination       0xYourDestinationWallet \
 *     --amount            5.0 \
 *     --chain             arbitrum-sepolia \
 *     --confirmations     1
 *
 * Required:
 *   --coinspaid-address   CoinsPaid deposit address (from deposit script webhook output)
 *   --destination         Final destination wallet address
 *   --amount              Amount to withdraw (human-readable, e.g. "5.0")
 *
 * Optional:
 *   --chain               Chain to use. Default: auto-detected from DB
 *   --confirmations       Blocks to wait before AML. Default: 20 (use 1 for testnet)
 *   --threshold           AML risk threshold 0–100. Default: 50
 *   --currency            CoinsPaid currency code override (auto-detected from DB)
 */

import 'dotenv/config';
import { privateKeyToAccount }            from 'viem/accounts';
import { secp256k1 }                      from '@noble/curves/secp256k1';
import { keccak_256 }                     from '@noble/hashes/sha3';
import { sha256 }                         from '@noble/hashes/sha256';
import { base58 }                         from '@scure/base';
import { KytSDK, VaultSecretsProvider }   from '../src/index.js';
import { DEFAULT_TOKENS }                 from '../src/config/tokens.js';
import { CHAIN_META }                     from '../src/config/chains.js';
import {
  CoinsPaidClient,
  reverseResolveCpCurrency,
  type CpPartyInfo,
}                                         from './lib/coinspaid.client.js';
import { CoinsPaidStorage }               from './lib/coinspaid.storage.js';
import { postWebhook }                    from './lib/payment_webhook.js';
import type { SupportedChain, TokenConfig, TrackingWallet } from '../src/types.js';

// ----------------------------------------------------------
// 1. Parse CLI args
// ----------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);

  let coinspaidAddress  = '';
  let destination       = '';
  let amount            = '';
  let currency          = '';
  let chainOverride: SupportedChain | undefined;
  let confirmations: number | undefined;
  let threshold         = 50;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--coinspaid-address' && argv[i+1]) { coinspaidAddress = argv[++i]!; }
    if (argv[i] === '--destination'       && argv[i+1]) { destination      = argv[++i]!; }
    if (argv[i] === '--amount'            && argv[i+1]) { amount           = argv[++i]!; }
    if (argv[i] === '--currency'          && argv[i+1]) { currency         = argv[++i]!; }
    if (argv[i] === '--chain'             && argv[i+1]) { chainOverride    = argv[++i]! as SupportedChain; }
    if (argv[i] === '--confirmations'     && argv[i+1]) { confirmations    = Number(argv[++i]); }
    if (argv[i] === '--threshold'         && argv[i+1]) { threshold        = Number(argv[++i]); }
  }

  const missing: string[] = [];
  if (!coinspaidAddress) missing.push('--coinspaid-address');
  if (!destination)      missing.push('--destination');
  if (!amount)           missing.push('--amount');

  if (missing.length > 0) {
    console.error(`ERROR: Missing required args: ${missing.join(', ')}`);
    console.error('');
    console.error('Usage:');
    console.error('  npm run cp:withdraw -- \\');
    console.error('    --coinspaid-address 0x... \\');
    console.error('    --destination 0x... \\');
    console.error('    --amount 5.0 \\');
    console.error('    --confirmations 1');
    process.exit(1);
  }

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    console.error(`ERROR: --amount must be a positive number (got "${amount}")`);
    process.exit(1);
  }

  return { coinspaidAddress, destination, amount, currency, chainOverride, confirmations, threshold };
}

const args = parseArgs();

// ----------------------------------------------------------
// 2. Open DB and resolve payment record
// ----------------------------------------------------------

const DB_PATH   = process.env['KYT_DB_PATH'] ?? './kyt-sdk.db';
const cpStorage = new CoinsPaidStorage(DB_PATH);

const cpAddrRecord = cpStorage.findAddressByDepositAddress(args.coinspaidAddress);
if (!cpAddrRecord) {
  console.error(`ERROR: CoinsPaid address "${args.coinspaidAddress}" not found in database.`);
  console.error('       Make sure deposit-to-coinspaid.ts ran and created this address.');
  process.exit(1);
}

const cpRecord = cpStorage.findPaymentById(cpAddrRecord.payment_id);
if (!cpRecord) {
  console.error(`ERROR: Parent payment record not found for address "${args.coinspaidAddress}"`);
  process.exit(1);
}

const currency   = args.currency    || cpAddrRecord.cp_currency;
const chain      = args.chainOverride ?? (cpRecord.chain as SupportedChain);
const customerId = cpRecord.customer_id;

// ----------------------------------------------------------
// 3. Secrets + SDK init
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
  riskThreshold:        args.threshold,
  pollingIntervalMs:    60_000,
  confirmationsRequired: args.confirmations,
  dbPath:               DB_PATH,
});

// ----------------------------------------------------------
// 4. CoinsPaid client — validate minimum withdrawal
// ----------------------------------------------------------

const [cpApiKey, cpApiSecret] = await Promise.all([
  secrets.getCoinsPaidApiKey(),
  secrets.getCoinsPaidApiSecret(),
]);
const coinspaid = new CoinsPaidClient(
  process.env['COINSPAID_API_URL'] ?? 'https://app.sandbox.cryptoprocessing.com/api/v2',
  cpApiKey,
  cpApiSecret,
);

const minWithdrawal = await coinspaid.getMinimumWithdrawal(currency);
if (minWithdrawal !== null && parseFloat(args.amount) < minWithdrawal) {
  console.error(`ERROR: Amount ${args.amount} ${currency} is below CoinsPaid minimum withdrawal of ${minWithdrawal}`);
  process.exit(1);
}

// ----------------------------------------------------------
// 5. Helpers
// ----------------------------------------------------------

const ALL_CHAIN_TOKENS: TokenConfig[] = DEFAULT_TOKENS[chain] ?? [];

// Only process the token that CoinsPaid will actually send — ignore everything else on the wallet
const expectedTokenSymbol = reverseResolveCpCurrency(chain, currency);
const expectedTokenCfg    = ALL_CHAIN_TOKENS.find(t => t.symbol === expectedTokenSymbol);

function isExpectedToken(tokenSymbol: string): boolean {
  return !expectedTokenSymbol || tokenSymbol === expectedTokenSymbol;
}

// Extract a contract address from a viem revert error message (for noise filtering)
function extractContractAddress(msg: string): string | null {
  const m = msg.match(/address:\s+(0x[a-fA-F0-9]{40})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function fmtTokenAmount(amount: bigint, decimals: number, symbol: string): string {
  const div   = BigInt(10 ** decimals);
  const whole = amount / div;
  const frac  = (amount % div).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac} ${symbol}`;
}

function fmtNative(wei: bigint, c: SupportedChain): string {
  const div = c === 'tron' ? 1_000_000n : 1_000_000_000_000_000_000n;
  const pad = c === 'tron' ? 6 : 18;
  const whole = wei / div;
  const frac  = (wei % div).toString().padStart(pad, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function errorBox(title: string, lines: string[]): void {
  console.error(`\n╔══ ACTION REQUIRED — ${title} ══╗`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
}

async function resolveGasWalletAddress(c: SupportedChain): Promise<string | null> {
  const rawKey = await secrets.getGasReservePrivateKey().catch(() => null);
  if (!rawKey) return null;
  if (c === 'tron') return gasKeyToTronAddress(rawKey.replace(/^0x/, ''));
  const evmKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
  return privateKeyToAccount(evmKey).address;
}

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

async function sweepNativeToGasWallet(wallet: TrackingWallet, c: SupportedChain, gasAddr: string): Promise<void> {
  const meta = CHAIN_META[c];
  console.log(`[SWEEP]     Returning leftover ${meta.nativeSymbol} to gas reserve (${gasAddr})...`);
  try {
    const result = await sdk.manualTransfer({
      walletIndex:        wallet.index,
      chain:              c,
      destinationAddress: gasAddr,
    });
    console.log(`[SWEEP]     Done — ${result.amount} returned — tx ${result.txHash}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[SWEEP]     Nothing to sweep (${msg})`);
  }
}

// ----------------------------------------------------------
// 6. SDK event listeners (Layer 3 only)
// ----------------------------------------------------------

let gasWalletAddress: string | null = null;
let wallet2: TrackingWallet;
const doneWallets = new Set<string>();

sdk.on('transaction.detected', ({ transaction }) => {
  if (transaction.chain !== chain) return;
  if (!isExpectedToken(transaction.tokenSymbol)) return;
  const tokenCfg = ALL_CHAIN_TOKENS.find(t => t.symbol === transaction.tokenSymbol);
  if (!tokenCfg) return;
  console.log(`\n[STEP 3]    Deposit detected on Layer 3 (from CoinsPaid withdrawal)`);
  console.log(`[L3 IN]     ${fmtTokenAmount(transaction.amount, tokenCfg.decimals, tokenCfg.symbol)}`);
  console.log(`            tx     : ${transaction.txHash}`);
  console.log(`            sender : ${transaction.sender}`);
  console.log(`            Running AML check on CoinsPaid sender...`);
  void postWebhook({
    event:       'l3_deposit_detected',
    tx_hash:     transaction.txHash,
    amount:      fmtTokenAmount(transaction.amount, tokenCfg.decimals, tokenCfg.symbol),
    token:       tokenCfg.symbol,
    from:        transaction.sender,
    chain,
    customer_id: customerId,
  });
});

sdk.on('transaction.confirmed', ({ transaction }) => {
  if (transaction.chain !== chain) return;
  if (!isExpectedToken(transaction.tokenSymbol)) return;
  if (doneWallets.has(transaction.walletId)) return;
  console.log(`\n[L3 CONFIRMED]  tx confirmed (${transaction.txHash})`);
  console.log(`                AML check running on CoinsPaid sender...`);
});

sdk.on('kyt.checking', ({ sender }) => {
  console.log(`[AML L3]    Checking CoinsPaid address: ${sender}`);
});

sdk.on('kyt.passed', ({ transaction, score, report }) => {
  if (!isExpectedToken(transaction.tokenSymbol)) return;
  const tokenCfg = ALL_CHAIN_TOKENS.find(t => t.symbol === transaction.tokenSymbol);
  const amt = tokenCfg
    ? fmtTokenAmount(transaction.amount, tokenCfg.decimals, tokenCfg.symbol)
    : `${transaction.amount} raw`;
  console.log(`[AML L3 PASS]  Score ${score} / ${report.risk_assessment.score_max} — ${report.risk_assessment.risk_level}`);
  console.log(`            ${amt} — forwarding to destination wallet (${args.destination})`);
  void postWebhook({
    event:       'aml_passed',
    layer:       'L3',
    score,
    risk_level:  report.risk_assessment.risk_level,
    tx_hash:     transaction.txHash,
    customer_id: customerId,
  });
});

sdk.on('kyt.blocked', ({ transaction, score, report }) => {
  if (!isExpectedToken(transaction.tokenSymbol)) return;
  sdk.pauseTrackingWallet(transaction.walletId);
  console.warn(`\n[AML L3 BLOCK]  Score ${score} / ${report.risk_assessment.score_max} — FLAGGED`);
  console.warn(`              Risk     : ${report.risk_assessment.risk_level}`);
  if (report.risk_assessment.blacklist_note) {
    console.warn(`              Note     : ${report.risk_assessment.blacklist_note}`);
  }
  const w2addr = chain === 'tron' ? wallet2?.tronAddress : wallet2?.evmAddress;
  errorBox('Layer 3 AML block — manual review required', [
    `Buffer Wallet 2 : ${w2addr ?? 'unknown'}`,
    `Score           : ${score} / ${report.risk_assessment.score_max}`,
    `Funds are SAFE on buffer wallet 2.`,
    `Recovery after review:`,
    `  npm run manual:transfer -- --from ${w2addr} --to ${args.destination} --chain ${chain}`,
  ]);
  void postWebhook({
    event:        'aml_blocked',
    layer:        'L3',
    score,
    risk_level:   report.risk_assessment.risk_level,
    tx_hash:      transaction.txHash,
    customer_id:  customerId,
    wallet:       w2addr ?? null,
    destination:  args.destination,
    note:         report.risk_assessment.blacklist_note ?? null,
  });
});

sdk.on('gas.low', ({ chain: c, currentBalance, required }) => {
  const meta = CHAIN_META[c];
  console.log(`\n[GAS]       Buffer wallet needs gas on ${meta.name}`);
  console.log(`            Have: ${fmtNative(currentBalance, c)} ${meta.nativeSymbol}  Need: ${fmtNative(required, c)} ${meta.nativeSymbol}`);
  console.log(`            Topping up from gas reserve (${gasWalletAddress ?? 'unknown'})...`);
});

sdk.on('gas.swept', ({ chain: c, amount, txHash }) => {
  const meta = CHAIN_META[c];
  console.log(`[GAS OK]    Topped up — ${fmtNative(amount, c)} ${meta.nativeSymbol} sent — tx ${txHash}`);
});

sdk.on('transfer.initiated', ({ token, amount, destination }) => {
  if (!isExpectedToken(token)) return;
  const tokenCfg = ALL_CHAIN_TOKENS.find(t => t.symbol === token);
  const decimals = tokenCfg?.decimals ?? 6;
  console.log(`\n[L3 OUT]    ${fmtTokenAmount(amount, decimals, token)} → ${destination}`);
});

sdk.on('transfer.completed', async ({ walletId, chain: c, txHash, token, amount }) => {
  if (!isExpectedToken(token)) return;
  doneWallets.add(walletId);
  const tokenCfg = ALL_CHAIN_TOKENS.find(t => t.symbol === token);
  const decimals = tokenCfg?.decimals ?? 6;
  const humanAmt = fmtTokenAmount(amount, decimals, token);
  console.log(`\n[L3 OUT]    Delivered ${humanAmt} to destination wallet`);
  console.log(`            tx                 : ${txHash}`);
  console.log(`            Destination wallet : ${args.destination}`);
  cpStorage.updatePaymentStatus(cpRecord.id, 'completed');
  console.log(`[DONE]      Payment flow complete.`);

  await postWebhook({
    event:       'transfer_completed',
    tx_hash:     txHash,
    amount:      humanAmt,
    token,
    destination: args.destination,
    chain:       c,
    customer_id: customerId,
  });

  if (gasWalletAddress) {
    await sweepNativeToGasWallet(wallet2, c, gasWalletAddress);
  }

  sdk.pauseTrackingWallet(wallet2.id);
  console.log('\nShutting down...\n');
  cpStorage.close();
  await sdk.shutdown();
  process.exit(0);
});

sdk.on('error', ({ error, context, chain: errChain }) => {
  const c = errChain ?? chain;

  // Silently ignore forward failures for tokens we're not expecting on this wallet
  if (context === 'forward_funds' && expectedTokenCfg) {
    const errContract = extractContractAddress(error.message);
    if (errContract && errContract !== expectedTokenCfg.address.toLowerCase()) {
      return;
    }
  }

  if (error.message.includes('Gas reserve wallet has insufficient balance')) {
    const meta = CHAIN_META[c];
    errorBox(`Gas reserve wallet needs ${meta.nativeSymbol}`, [
      `Chain    : ${meta.name}`,
      `Address  : ${gasWalletAddress ?? '(run init_gas_wallets to see address)'}`,
      `Stablecoin funds are SAFE on buffer wallet 2.`,
    ]);
    void postWebhook({
      event:       'error',
      error_type:  'gas_reserve_insufficient',
      chain:       meta.name,
      gas_wallet:  gasWalletAddress ?? null,
      customer_id: customerId,
    });
    return;
  }
  const w2addr = chain === 'tron' ? wallet2?.tronAddress : wallet2?.evmAddress;
  errorBox('SDK error', [
    `Context       : ${context}`,
    `Error         : ${error.message}`,
    `Buffer W2     : ${w2addr ?? 'unknown'}`,
    `Funds are SAFE on buffer wallet 2 or in CoinsPaid.`,
    ...(w2addr ? [`Recovery: npm run manual:transfer -- --from ${w2addr} --to ${args.destination} --chain ${c}`] : []),
  ]);
  void postWebhook({
    event:       'error',
    error_type:  'sdk_error',
    context,
    message:     error.message,
    wallet:      w2addr ?? null,
    destination: args.destination,
    customer_id: customerId,
  });
});

// ----------------------------------------------------------
// 7. Main
// ----------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const w2addr = chain === 'tron' ? wallet2?.tronAddress : wallet2?.evmAddress;
  console.error(`\n[FATAL] Unhandled error: ${msg}`);
  if (w2addr) {
    console.error(`  Buffer Wallet 2 : ${w2addr}`);
    console.error(`  Funds are SAFE. Recovery: npm run manual:transfer -- --from ${w2addr} --to ${args.destination} --chain ${chain}`);
  } else {
    console.error(`  Funds are SAFE in CoinsPaid — retry this command or withdraw manually via dashboard.`);
  }
  void postWebhook({ event: 'error', error_type: 'fatal', message: msg, wallet: w2addr ?? null, customer_id: customerId });
  process.exit(1);
});

try {
  await sdk.initialize();
} catch (err) {
  console.error(`\n[STARTUP ERROR] SDK initialization failed: ${err instanceof Error ? err.message : err}`);
  console.error('Funds are SAFE in CoinsPaid. Safe to retry after fixing the error above.');
  process.exit(1);
}

gasWalletAddress = await resolveGasWalletAddress(chain);

const meta = CHAIN_META[chain];
const companyName    = process.env['COINSPAID_COMPANY_NAME']    ?? 'Unknown';
const companyCountry = process.env['COINSPAID_COMPANY_COUNTRY'] ?? 'EST';

const party: CpPartyInfo = {
  senderType:       'legal',
  senderData:       { legal_name: companyName, country_of_registration: companyCountry },
  endUserReference: customerId,
};

let wallet2Address: string;

try {
  // No self-transfer gate needed: the SDK auto-forwards after AML with no race condition
  wallet2 = await sdk.createTrackingWallet({
    chains:             [chain],
    destinationAddress: args.destination,
    label:              'L3-coinspaid-withdrawal',
    riskThreshold:      args.threshold,
  });
  wallet2Address = chain === 'tron' ? wallet2.tronAddress! : wallet2.evmAddress!;
} catch (err) {
  console.error(`\n[STARTUP ERROR] Failed to create buffer wallet 2: ${err instanceof Error ? err.message : err}`);
  console.error('Funds are SAFE in CoinsPaid. Retry this command.');
  await sdk.shutdown().catch(() => {});
  process.exit(1);
}

// Link wallet2 and destination to the payment record
cpStorage.updateReceivingWallet(cpRecord.id, wallet2.id, args.destination);

const withdrawalForeignId = `${cpRecord.foreign_id}-${currency.toLowerCase()}-wd`;

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║     B2B Payment — Layer 3  (CoinsPaid → Destination)           ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');
console.log(`  Chain             : ${meta.name}`);
console.log(`  CoinsPaid address : ${args.coinspaidAddress}`);
console.log(`  Currency          : ${currency}`);
console.log(`  Amount            : ${args.amount}`);
console.log(`  Buffer Wallet 2   : ${wallet2Address}`);
console.log(`  Destination       : ${args.destination}`);
console.log(`  Customer ID       : ${customerId}`);
console.log('');
console.log('  Initiating CoinsPaid withdrawal to Buffer Wallet 2...');

try {
  const withdrawal = await coinspaid.withdraw(
    currency,
    wallet2Address,
    args.amount,
    withdrawalForeignId,
    party,
  );

  cpStorage.updateAddressStatus(cpAddrRecord.id, 'withdrawal_initiated', {
    withdrawal_id: String(withdrawal.id),
  });

  console.log(`\n  Withdrawal initiated`);
  console.log(`  CoinsPaid withdrawal ID : ${withdrawal.id}`);
  console.log(`  Status                  : ${withdrawal.status}`);
  console.log(`\n  Monitoring buffer wallet 2 for incoming funds...`);
  console.log(`  AML check will run automatically on receipt.\n`);

  void postWebhook({
    event:                  'coinspaid_withdrawal_initiated',
    coinspaid_withdrawal_id: withdrawal.id,
    coinspaid_address:       args.coinspaidAddress,
    to_address:              wallet2Address,
    currency,
    amount:                  args.amount,
    customer_id:             customerId,
    destination:             args.destination,
  });

} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  cpStorage.updateAddressStatus(cpAddrRecord.id, 'error', { error_message: msg });

  console.error('\n╔══ ACTION REQUIRED ══════════════════════════════════════════════╗');
  console.error('  CoinsPaid withdrawal FAILED — funds are SAFE in CoinsPaid');
  console.error('');
  console.error(`  CoinsPaid address : ${args.coinspaidAddress}`);
  console.error(`  Currency          : ${currency}`);
  console.error(`  Amount            : ${args.amount}`);
  console.error(`  Buffer Wallet 2   : ${wallet2Address}`);
  console.error(`  Payment record    : ${cpRecord.id}`);
  console.error('');
  console.error(`  Error : ${msg}`);
  console.error('');
  console.error('  Options:');
  console.error('  1. Retry this command (same args — wallet 2 already created)');
  console.error('  2. Withdraw manually via CoinsPaid dashboard to:', wallet2Address);
  console.error('  3. Contact CoinsPaid support with payment record ID above');
  console.error('╚═════════════════════════════════════════════════════════════════╝');
  await postWebhook({
    event:            'error',
    error_type:       'withdrawal_failed',
    message:          msg,
    coinspaid_address: args.coinspaidAddress,
    currency,
    amount:           args.amount,
    buffer_wallet_2:  wallet2Address,
    payment_id:       cpRecord.id,
    customer_id:      customerId,
  });
  cpStorage.close();
  await sdk.shutdown();
  process.exit(1);
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  cpStorage.close();
  await sdk.shutdown();
  process.exit(0);
});

await new Promise(() => {});
