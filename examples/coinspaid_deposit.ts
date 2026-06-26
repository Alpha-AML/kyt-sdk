/**
 * coinspaid_deposit.ts  — Layer 1 + 2
 *
 * Creates Buffer Wallet 1, waits for user deposit, runs AML check,
 * then forwards funds to CoinsPaid. Shuts down automatically after
 * webhook confirmation and prints the cp:withdraw command to run next.
 *
 * Usage:
 *   npm run deposit:coinspaid -- \
 *     --expected-amount 5 \
 *     --customer-id customer-001 \
 *     --chain arbitrum-sepolia \
 *     --confirmations 1
 *
 * Required:
 *   --expected-amount  USD amount the user should send
 *   --customer-id      Your internal customer ID (stored in DB, sent to CoinsPaid)
 *
 * Optional:
 *   --chain            ethereum | arbitrum | arbitrum-sepolia | base | bsc | tron. Default: arbitrum
 *   --confirmations    Blocks to wait before AML. Default: 20 (use 1 for testnet)
 *   --threshold        AML risk threshold 0–100. Scores above this are blocked. Default: 50
 *   --tokens           Comma-separated token filter (e.g. USDC,USDT). Default: all
 *   --label            Human tag (invoice ID, order number)
 *   --company-name     CoinsPaid KYC company name. Default: COINSPAID_COMPANY_NAME env
 *   --company-country  ISO alpha-3 country code. Default: COINSPAID_COMPANY_COUNTRY env
 */

import 'dotenv/config';
import http                               from 'http';
import { v4 as uuidv4 }                  from 'uuid';
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
  resolveCpCurrency,
  type CpPartyInfo,
  type CoinsPaidWebhookPayload,
}                                         from './lib/coinspaid.client.js';
import { CoinsPaidStorage, type CoinsPaidAddressRecord } from './lib/coinspaid.storage.js';
import { postWebhook }                from './lib/payment_webhook.js';
import type { SupportedChain, TokenConfig, TrackingWallet } from '../src/types.js';

// ----------------------------------------------------------
// 1. Parse CLI args
// ----------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);

  let expectedAmount = 0;
  let chain: SupportedChain = 'arbitrum';
  let label: string | undefined;
  let threshold      = 50;
  let tokenFilter: string[] | undefined;
  let companyName    = process.env['COINSPAID_COMPANY_NAME']    ?? 'AlphaAML';
  let companyCountry = process.env['COINSPAID_COMPANY_COUNTRY'] ?? 'EST';
  let customerId     = '';
  let confirmations: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expected-amount' && argv[i+1]) { expectedAmount = Number(argv[++i]); }
    if (argv[i] === '--chain'           && argv[i+1]) { chain          = argv[++i]! as SupportedChain; }
    if (argv[i] === '--label'           && argv[i+1]) { label          = argv[++i]; }
    if (argv[i] === '--threshold'       && argv[i+1]) { threshold      = Number(argv[++i]); }
    if (argv[i] === '--confirmations'   && argv[i+1]) { confirmations  = Number(argv[++i]); }
    if (argv[i] === '--company-name'    && argv[i+1]) { companyName    = argv[++i]!; }
    if (argv[i] === '--company-country' && argv[i+1]) { companyCountry = argv[++i]!; }
    if (argv[i] === '--customer-id'     && argv[i+1]) { customerId     = argv[++i]!; }
    if (argv[i] === '--tokens'          && argv[i+1]) {
      tokenFilter = argv[++i]!.split(',').map(s => s.trim().toUpperCase());
    }
  }

  if (!expectedAmount || expectedAmount <= 0) {
    console.error('ERROR: --expected-amount must be a positive number.');
    process.exit(1);
  }
  if (!customerId) {
    console.error('ERROR: --customer-id is required.');
    console.error('  Example: npm run deposit:coinspaid -- --expected-amount 5 --customer-id user-42');
    process.exit(1);
  }

  return { expectedAmount, chain, label, threshold, confirmations, tokenFilter, companyName, companyCountry, customerId };
}

const args = parseArgs();

// ----------------------------------------------------------
// 2. Resolve tracked tokens
// ----------------------------------------------------------

const ALL_CHAIN_TOKENS: TokenConfig[] = DEFAULT_TOKENS[args.chain] ?? [];
const TRACKED_TOKENS: TokenConfig[]   = args.tokenFilter
  ? ALL_CHAIN_TOKENS.filter(t => args.tokenFilter!.includes(t.symbol))
  : ALL_CHAIN_TOKENS;

if (TRACKED_TOKENS.length === 0) {
  console.error(`ERROR: No tokens found for chain "${args.chain}".`);
  process.exit(1);
}

const EXPECTED_USD_MICRO = BigInt(Math.round(args.expectedAmount * 1_000_000));

function normalizeToUsdMicro(amount: bigint, decimals: number): bigint {
  if (decimals === 6) return amount;
  if (decimals > 6)   return amount / BigInt(10 ** (decimals - 6));
  return amount * BigInt(10 ** (6 - decimals));
}

// ----------------------------------------------------------
// 3. SDK + CoinsPaid init
// ----------------------------------------------------------

const DB_PATH = process.env['KYT_DB_PATH'] ?? './kyt-sdk.db';

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
  webhookUrl:           process.env['KYT_WEBHOOK_URL'],
});

const [cpApiKey, cpApiSecret] = await Promise.all([
  secrets.getCoinsPaidApiKey(),
  secrets.getCoinsPaidApiSecret(),
]);
const coinspaid = new CoinsPaidClient(
  process.env['COINSPAID_API_URL'] ?? 'https://app.sandbox.cryptoprocessing.com/api/v2',
  cpApiKey,
  cpApiSecret,
);

function buildCpParty(customerId: string): CpPartyInfo {
  return {
    senderType:       'legal',
    senderData:       { legal_name: args.companyName, country_of_registration: args.companyCountry },
    endUserReference: customerId,
  };
}

const cpStorage = new CoinsPaidStorage(DB_PATH);

let gasWalletAddress: string | null = null;
let wallet1: TrackingWallet;
let webhookServer: http.Server;

const coinspaidHandled = new Set<string>();

// ----------------------------------------------------------
// 4. Core flow: AML gate passed → forward to CoinsPaid
// ----------------------------------------------------------

async function createCoinsPaidAndForward(
  walletId:     string,
  walletIndex:  number,
  tokenSymbol:  string,
  tokenAddress: string,
  amount:       bigint,
): Promise<void> {
  const key = `${walletId}:${tokenSymbol}`;
  if (coinspaidHandled.has(key)) return;
  coinspaidHandled.add(key);

  sdk.pauseTrackingWallet(walletId);

  const cpRecord = cpStorage.findPaymentBySourceWalletId(walletId);
  if (!cpRecord) {
    console.error(`[COINSPAID]  No payment record for wallet ${walletId}`);
    return;
  }

  const cpCurrency = resolveCpCurrency(args.chain, tokenSymbol);
  if (!cpCurrency) {
    const msg = `Token ${tokenSymbol} not supported by CoinsPaid on chain "${args.chain}"`;
    cpStorage.updatePaymentStatus(cpRecord.id, 'error', msg);
    const depositAddr = args.chain === 'tron' ? wallet1.tronAddress : wallet1.evmAddress;
    errorBox(`Token ${tokenSymbol} not supported by CoinsPaid on ${args.chain}`, [
      `Wallet ID : ${walletId}`,
      `Add the currency mapping to COINSPAID_CURRENCY in coinspaid.client.ts`,
      `Funds are SAFE on buffer wallet 1 (${depositAddr}).`,
    ]);
    void postWebhook({
      event:       'error',
      error_type:  'unsupported_token',
      token:       tokenSymbol,
      chain:       args.chain,
      wallet:      depositAddr,
      customer_id: cpRecord.customer_id,
    });
    return;
  }

  const cpForeignId = `${walletId}:${tokenSymbol.toLowerCase()}`;

  console.log(`\n[STEP 2]    AML + gas passed — starting CoinsPaid layer`);
  console.log(`[COINSPAID] Creating ${tokenSymbol} (${cpCurrency}) deposit address...`);

  const party = buildCpParty(cpRecord.customer_id);
  let cpAddrRecord: CoinsPaidAddressRecord | undefined;

  try {
    const cpAddr = await coinspaid.createAddress(cpCurrency, cpForeignId, party);
    console.log(`[COINSPAID] Address: ${cpAddr.address}`);

    cpAddrRecord = {
      id:                uuidv4(),
      payment_id:        cpRecord.id,
      token_symbol:      tokenSymbol,
      cp_currency:       cpCurrency,
      cp_foreign_id:     cpForeignId,
      coinspaid_address: cpAddr.address,
      status:            'address_created',
      sent_amount:       null,
      received_amount:   null,
      withdrawal_id:     null,
      error_message:     null,
      created_at:        Date.now(),
    };
    cpStorage.insertAddress(cpAddrRecord);
    cpStorage.updatePaymentStatus(cpRecord.id, 'processing');

    const tokenCfg = TRACKED_TOKENS.find(t => t.symbol === tokenSymbol);
    if (!tokenCfg) throw new Error(`Token config not found for ${tokenSymbol}`);

    const humanAmount  = Number(amount) / Math.pow(10, tokenCfg.decimals);
    const cpMinDeposit = await coinspaid.getMinimumDeposit(cpCurrency);
    if (cpMinDeposit !== null && humanAmount < cpMinDeposit) {
      throw new Error(
        `Amount ${humanAmount} ${tokenSymbol} is below CoinsPaid minimum deposit of ${cpMinDeposit} ${cpCurrency}.`,
      );
    }

    console.log(`[COINSPAID] Forwarding ${fmtTokenAmount(amount, tokenCfg.decimals, tokenSymbol)} → ${cpAddr.address}`);

    const result = await sdk.manualTransfer({
      walletIndex,
      chain:              args.chain,
      destinationAddress: cpAddr.address,
      tokenAddress:       tokenCfg.address,
      amount,
    });

    cpStorage.updateAddressStatus(cpAddrRecord.id, 'forwarded', { sent_amount: String(amount) });

    console.log(`[COINSPAID] Sent — tx ${result.txHash}`);
    console.log(`[COINSPAID] Waiting for CoinsPaid deposit confirmation (webhook)...`);
    void postWebhook({
      event:             'coinspaid_forwarded',
      tx_hash:           result.txHash,
      coinspaid_address: cpAddr.address,
      currency:          cpCurrency,
      amount:            fmtTokenAmount(amount, tokenCfg.decimals, tokenSymbol),
      customer_id:       cpRecord.customer_id,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cpAddrRecord) cpStorage.updateAddressStatus(cpAddrRecord.id, 'error', { error_message: msg });
    cpStorage.updatePaymentStatus(cpRecord.id, 'error', `CoinsPaid step failed for ${tokenSymbol}: ${msg}`);
    const depositAddr = args.chain === 'tron' ? wallet1.tronAddress : wallet1.evmAddress;
    errorBox('CoinsPaid step failed — funds held on buffer wallet 1', [
      `Buffer Wallet 1 : ${depositAddr}`,
      `Token           : ${tokenSymbol}  (${cpCurrency})`,
      `Error           : ${msg}`,
      '',
      `Funds are SAFE on buffer wallet 1.`,
      `Forward manually after fixing:`,
      `  npm run manual:transfer -- --from ${depositAddr} --to <coinspaid_address> --chain ${args.chain}`,
    ]);
    void postWebhook({
      event:       'error',
      error_type:  'coinspaid_step_failed',
      token:       tokenSymbol,
      currency:    cpCurrency,
      message:     msg,
      wallet:      depositAddr,
      customer_id: cpRecord.customer_id,
    });
  }
}

// ----------------------------------------------------------
// 5. Amount tracking
// ----------------------------------------------------------

const received = new Map<string, bigint>();

function addReceived(walletId: string, usdMicro: bigint): bigint {
  const prev = received.get(walletId) ?? 0n;
  const next = prev + usdMicro;
  received.set(walletId, next);
  return next;
}

// ----------------------------------------------------------
// 6. Display helpers
// ----------------------------------------------------------

function fmtUsd(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac  = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `$${whole}.${frac}`;
}

function fmtTokenAmount(amount: bigint, decimals: number, symbol: string): string {
  const div   = BigInt(10 ** decimals);
  const whole = amount / div;
  const frac  = (amount % div).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac} ${symbol}`;
}

function fmtNative(wei: bigint, chain: SupportedChain): string {
  const div = chain === 'tron' ? 1_000_000n : 1_000_000_000_000_000_000n;
  const pad = chain === 'tron' ? 6 : 18;
  const whole = wei / div;
  const frac  = (wei % div).toString().padStart(pad, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function errorBox(title: string, lines: string[]): void {
  console.error(`\n╔══ ACTION REQUIRED — ${title} ══╗`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
}

// ----------------------------------------------------------
// 7. Event listeners (Layer 1 only)
// ----------------------------------------------------------

sdk.on('transaction.detected', ({ transaction }) => {
  if (transaction.chain !== args.chain) return;
  const tokenCfg = TRACKED_TOKENS.find(t => t.symbol === transaction.tokenSymbol);
  if (!tokenCfg) return;

  const usdMicro = normalizeToUsdMicro(transaction.amount, tokenCfg.decimals);
  const total    = addReceived(transaction.walletId, usdMicro);

  console.log(`\n[STEP 1]    Deposit detected on Layer 1`);
  console.log(`[L1 IN]     ${fmtTokenAmount(transaction.amount, tokenCfg.decimals, tokenCfg.symbol)}`);
  console.log(`            tx     : ${transaction.txHash}`);
  console.log(`            sender : ${transaction.sender}`);
  console.log(`            total  : ${fmtUsd(total)} / ${fmtUsd(EXPECTED_USD_MICRO)} expected`);

  if (total < EXPECTED_USD_MICRO) {
    console.log(`            Waiting for remaining ${fmtUsd(EXPECTED_USD_MICRO - total)}...`);
  } else {
    console.log(`            Expected amount reached — waiting for confirmations + AML...`);
  }

  void postWebhook({
    event:       'deposit_detected',
    tx_hash:     transaction.txHash,
    amount:      fmtTokenAmount(transaction.amount, tokenCfg.decimals, tokenCfg.symbol),
    token:       tokenCfg.symbol,
    from:        transaction.sender,
    chain:       args.chain,
    customer_id: args.customerId,
  });
});

sdk.on('transaction.confirmed', ({ transaction }) => {
  if (transaction.chain !== args.chain) return;
  console.log(`\n[L1 CONFIRMED]  tx confirmed (${transaction.txHash})`);
  console.log(`                AML check running...`);
});

sdk.on('kyt.checking', ({ sender }) => {
  console.log(`[AML L1]    Checking sender: ${sender}`);
});

sdk.on('kyt.passed', ({ transaction, score, report }) => {
  const tokenCfg = TRACKED_TOKENS.find(t => t.symbol === transaction.tokenSymbol);
  const amt = tokenCfg
    ? fmtTokenAmount(transaction.amount, tokenCfg.decimals, tokenCfg.symbol)
    : `${transaction.amount} raw`;
  console.log(`[AML L1 PASS]  Score ${score} / ${report.risk_assessment.score_max} — ${report.risk_assessment.risk_level}`);
  console.log(`            ${amt} — sender is clean`);
  console.log(`            Checking gas... then creating CoinsPaid address`);
  void postWebhook({
    event:       'aml_passed',
    layer:       'L1',
    score,
    risk_level:  report.risk_assessment.risk_level,
    tx_hash:     transaction.txHash,
    customer_id: args.customerId,
  });
});

sdk.on('kyt.blocked', async ({ transaction, score, report }) => {
  const cpRecord = cpStorage.findPaymentBySourceWalletId(transaction.walletId);
  if (cpRecord) cpStorage.updatePaymentStatus(cpRecord.id, 'error', `AML blocked: score ${score}`);
  sdk.pauseTrackingWallet(transaction.walletId);

  console.warn(`\n[AML L1 BLOCK]  Score ${score} / ${report.risk_assessment.score_max} — FLAGGED`);
  console.warn(`              Risk     : ${report.risk_assessment.risk_level}`);
  if (report.risk_assessment.blacklist_note) {
    console.warn(`              Note     : ${report.risk_assessment.blacklist_note}`);
  }

  const depositAddr = args.chain === 'tron' ? wallet1.tronAddress : wallet1.evmAddress;
  errorBox('Layer 1 AML block — funds held, manual review required', [
    `Buffer Wallet 1 : ${depositAddr}`,
    `Score           : ${score} / ${report.risk_assessment.score_max}`,
    `Funds are SAFE on buffer wallet 1 — do NOT auto-forward.`,
    `After compliance review, return funds:`,
    `  npm run manual:transfer -- --from ${depositAddr} --to <RETURN_ADDRESS> --chain ${args.chain}`,
  ]);
  await postWebhook({
    event:        'aml_blocked',
    layer:        'L1',
    score,
    risk_level:   report.risk_assessment.risk_level,
    tx_hash:      transaction.txHash,
    customer_id:  args.customerId,
    wallet:       depositAddr,
    note:         report.risk_assessment.blacklist_note ?? null,
  });

  webhookServer?.close();
  cpStorage.close();
  await sdk.shutdown();
  process.exit(1);
});

sdk.on('gas.low', ({ chain, currentBalance, required }) => {
  const meta = CHAIN_META[chain];
  console.log(`\n[GAS]       Buffer wallet needs gas on ${meta.name}`);
  console.log(`            Have: ${fmtNative(currentBalance, chain)} ${meta.nativeSymbol}  Need: ${fmtNative(required, chain)} ${meta.nativeSymbol}`);
  console.log(`            Topping up from gas reserve (${gasWalletAddress ?? 'unknown'})...`);
});

sdk.on('gas.swept', ({ chain, amount, txHash }) => {
  const meta = CHAIN_META[chain];
  console.log(`[GAS OK]    Topped up — ${fmtNative(amount, chain)} ${meta.nativeSymbol} sent — tx ${txHash}`);
});

sdk.on('kyt.passed', async ({ transaction, score }) => {
  const tokenCfg = ALL_CHAIN_TOKENS.find(t => t.symbol === transaction.tokenSymbol);
  if (!tokenCfg) return;
  await createCoinsPaidAndForward(
    transaction.walletId,
    wallet1.index,
    transaction.tokenSymbol,
    tokenCfg.address,
    transaction.amount,
  );
});

sdk.on('error', ({ error, context, chain: errChain }) => {
  const chain = errChain ?? args.chain;
  if (error.message.includes('Gas reserve wallet has insufficient balance')) {
    const meta = CHAIN_META[chain];
    errorBox(`Gas reserve wallet needs ${meta.nativeSymbol}`, [
      `Chain    : ${meta.name}`,
      `Address  : ${gasWalletAddress ?? '(run init_gas_wallets to see address)'}`,
      `Deposit  : at least ${fmtNative(meta.defaultTopUpWei, chain)} ${meta.nativeSymbol}`,
      '',
      `Stablecoin funds are SAFE on the buffer wallet.`,
    ]);
    void postWebhook({
      event:       'error',
      error_type:  'gas_reserve_insufficient',
      chain:       CHAIN_META[chain].name,
      gas_wallet:  gasWalletAddress ?? null,
      customer_id: args.customerId,
    });
    return;
  }
  const depositAddr = args.chain === 'tron' ? wallet1?.tronAddress : wallet1?.evmAddress;
  errorBox('SDK error', [
    `Context  : ${context}`,
    `Error    : ${error.message}`,
    ...(depositAddr ? [
      `Buffer W1 : ${depositAddr}`,
      `Recovery  : npm run manual:transfer -- --from ${depositAddr} --to <destination> --chain ${chain}`,
    ] : []),
  ]);
  void postWebhook({
    event:       'error',
    error_type:  'sdk_error',
    context,
    message:     error.message,
    wallet:      depositAddr ?? null,
    customer_id: args.customerId,
  });
});

// ----------------------------------------------------------
// 8. CoinsPaid webhook server
// ----------------------------------------------------------

const WEBHOOK_PORT = Number(process.env['COINSPAID_WEBHOOK_PORT'] ?? 3000);

function startWebhookServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody   = Buffer.concat(chunks).toString();
      const signature = (req.headers['x-processing-signature'] as string) ?? '';

      if (!coinspaid.verifyWebhook(rawBody, signature)) {
        console.warn('[WEBHOOK]   Invalid signature — rejected');
        res.writeHead(401).end();
        return;
      }

      res.writeHead(200).end('OK');

      let payload: CoinsPaidWebhookPayload;
      try { payload = JSON.parse(rawBody) as CoinsPaidWebhookPayload; }
      catch { console.warn('[WEBHOOK]   Failed to parse JSON'); return; }

      handleCoinsPaidWebhook(payload).catch(err => {
        console.error('[WEBHOOK]   Handler error:', err instanceof Error ? err.message : err);
      });
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[WEBHOOK] ERROR: Port ${WEBHOOK_PORT} is already in use.`);
      console.error(`  Stop the process on that port, or set COINSPAID_WEBHOOK_PORT in .env to a different value.`);
    } else {
      console.error(`\n[WEBHOOK] Server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`\n[WEBHOOK]   Listening on port ${WEBHOOK_PORT}`);
    console.log(`[WEBHOOK]   Local test: npx ngrok http ${WEBHOOK_PORT}`);
    console.log(`[WEBHOOK]   Set the ngrok URL in CoinsPaid dashboard → Callbacks\n`);
  });

  return server;
}

async function handleCoinsPaidWebhook(payload: CoinsPaidWebhookPayload): Promise<void> {
  console.log(`\n[WEBHOOK]   Received: type=${payload.type} status=${payload.status}`);

  if (payload.type !== 'deposit' || payload.status !== 'confirmed') return;

  const rawForeignId = payload.crypto_address?.foreign_id;
  if (!rawForeignId) { console.warn('[WEBHOOK]   No foreign_id — skipping'); return; }

  const baseWalletId = rawForeignId.split(':')[0];
  if (!baseWalletId) { console.warn('[WEBHOOK]   Could not parse wallet ID'); return; }

  const cpRecord = cpStorage.findPaymentByForeignId(baseWalletId);
  if (!cpRecord) { console.warn(`[WEBHOOK]   No payment record for wallet: ${baseWalletId}`); return; }

  const cpAddrRecord = cpStorage.findAddressByCpForeignId(rawForeignId);
  const { currency, amount } = payload.currency_received;
  const coinspaidDepositAddr  = payload.crypto_address?.address ?? 'unknown';

  if (cpAddrRecord) {
    cpStorage.updateAddressStatus(cpAddrRecord.id, 'confirmed', { received_amount: amount });
  }

  console.log(`\n[WEBHOOK]   CoinsPaid deposit confirmed`);
  console.log(`            Currency          : ${currency}`);
  console.log(`            Amount            : ${amount}`);
  console.log(`            CoinsPaid address : ${coinspaidDepositAddr}`);

  await postWebhook({
    event:             'coinspaid_deposit_confirmed',
    amount,
    currency,
    coinspaid_address: coinspaidDepositAddr,
    customer_id:       cpRecord.customer_id,
  });

  console.log(`\n[WEBHOOK]   Run the withdrawal script to complete the payment:`);
  console.log(`\n            npm run cp:withdraw -- \\`);
  console.log(`              --coinspaid-address ${coinspaidDepositAddr} \\`);
  console.log(`              --destination <YOUR_DESTINATION_WALLET> \\`);
  console.log(`              --amount ${amount} \\`);
  console.log(`              --chain ${cpRecord.chain} \\`);
  console.log(`              --confirmations ${args.confirmations ?? 20}`);
  console.log(`\n[DONE]      Layer 2 complete.`);

  if (gasWalletAddress) {
    await sweepNativeToGasWallet(args.chain, gasWalletAddress);
  }

  console.log('\nShutting down.\n');
  webhookServer.close();

  cpStorage.close();
  await sdk.shutdown();
  process.exit(0);
}

// ----------------------------------------------------------
// 9. Helpers
// ----------------------------------------------------------

async function sweepNativeToGasWallet(chain: SupportedChain, gasAddr: string): Promise<void> {
  const meta = CHAIN_META[chain];
  console.log(`[SWEEP]     Returning leftover ${meta.nativeSymbol} to gas reserve (${gasAddr})...`);
  try {
    const result = await sdk.manualTransfer({
      walletIndex:        wallet1.index,
      chain,
      destinationAddress: gasAddr,
    });
    console.log(`[SWEEP]     Done — ${result.amount} returned — tx ${result.txHash}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[SWEEP]     Nothing to sweep (${msg})`);
  }
}

async function resolveGasWalletAddress(chain: SupportedChain): Promise<string | null> {
  const rawKey = await secrets.getGasReservePrivateKey().catch(() => null);
  if (!rawKey) return null;
  if (chain === 'tron') return gasKeyToTronAddress(rawKey.replace(/^0x/, ''));
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

// ----------------------------------------------------------
// 10. Main
// ----------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const depositAddr = args.chain === 'tron' ? wallet1?.tronAddress : wallet1?.evmAddress;
  console.error(`\n[FATAL] Unhandled error: ${msg}`);
  if (depositAddr) {
    console.error(`  Buffer Wallet 1 : ${depositAddr}`);
    console.error(`  Funds are SAFE. Recovery: npm run manual:transfer -- --from ${depositAddr} --to <destination> --chain ${args.chain}`);
  }
  void postWebhook({ event: 'error', error_type: 'fatal', message: msg, wallet: depositAddr ?? null, customer_id: args.customerId });
  process.exit(1);
});

try {
  await sdk.initialize();
} catch (err) {
  console.error(`\n[STARTUP ERROR] SDK initialization failed: ${err instanceof Error ? err.message : err}`);
  console.error('No funds have been moved. Safe to retry after fixing the error above.');
  process.exit(1);
}

gasWalletAddress = await resolveGasWalletAddress(args.chain);

const meta = CHAIN_META[args.chain];

try {
  wallet1 = await sdk.createTrackingWallet({
    chains:        [args.chain],
    label:         args.label ? `${args.label}-L1` : 'L1-user-deposit',
    riskThreshold: args.threshold,
  });
} catch (err) {
  console.error(`\n[STARTUP ERROR] Failed to create buffer wallet 1: ${err instanceof Error ? err.message : err}`);
  console.error('No funds have been moved. Safe to retry.');
  await sdk.shutdown().catch(() => {});
  process.exit(1);
}

cpStorage.insertPayment({
  id:                  uuidv4(),
  foreign_id:          wallet1.id,
  customer_id:         args.customerId,
  chain:               args.chain,
  source_wallet_id:    wallet1.id,
  receiving_wallet_id: '',  // set by cp:withdraw when it creates buffer wallet 2
  treasury_address:    '',  // set by cp:withdraw
  status:              'pending',
  expected_amount:     String(args.expectedAmount),
  error_message:       null,
  created_at:          Date.now(),
});

webhookServer = startWebhookServer();

const depositAddress = args.chain === 'tron' ? wallet1.tronAddress : wallet1.evmAddress;

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║     B2B Payment — Layer 1 + 2  (Deposit → CoinsPaid)           ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');
console.log(`  Chain           : ${meta.name}`);
console.log(`  Accepted tokens : ${TRACKED_TOKENS.map(t => t.symbol).join(', ')}`);
console.log(`  Expected amount : ${fmtUsd(EXPECTED_USD_MICRO)}`);
console.log(`  Risk threshold  : ${args.threshold}`);
console.log(`  Customer ID     : ${args.customerId}`);
if (args.label) console.log(`  Label           : ${args.label}`);
console.log(`\n  ┌─ Step 1 ─ Layer 1: User Deposit Buffer`);
console.log(`  │   Wallet ID      : ${wallet1.id}`);
console.log(`  │   DEPOSIT HERE → : ${depositAddress}`);
console.log(`  │   Flow           : deposit → AML check → gas check → proceed`);
console.log(`  │`);
console.log(`  └─ Step 2 ─ Layer 2: CoinsPaid`);
console.log(`      Address        : created per-token after Step 1 completes`);
console.log(`      Flow           : create address → receive funds → webhook → print cp:withdraw`);
console.log('\nMonitoring for incoming transfers. Press Ctrl+C to stop.\n');

void postWebhook({
  event:           'deposit_address_ready',
  message:         'Client should deposit here',
  address:         depositAddress,
  chain:           args.chain,
  tokens:          TRACKED_TOKENS.map(t => ({ symbol: t.symbol, address: t.address })),
  expected_amount: args.expectedAmount,
  customer_id:     args.customerId,
  ...(args.label ? { label: args.label } : {}),
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  webhookServer.close();

  cpStorage.close();
  await sdk.shutdown();
  process.exit(0);
});

await new Promise(() => {});
