/**
 * Basic SDK usage example — .env secrets provider.
 *
 * Prerequisites:
 *   1. Copy .env.example → .env and fill in your values.
 *   2. Fund the gas reserve wallet on each chain you use.
 *   3. npm run example:basic
 */
import 'dotenv/config';
import { KytSDK, EnvSecretsProvider } from '../src/index.js';

// ----------------------------------------------------------
// 1. Initialise the SDK
// ----------------------------------------------------------

const sdk = new KytSDK({
  chains: {
    ethereum: { rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY' },
    arbitrum: { rpcUrl: 'https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY' },
    base:     { rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY' },
  },

  secrets: new EnvSecretsProvider(), // reads KYT_* env vars

  riskThreshold:    50,        // block if score > 50
  pollingIntervalMs: 60_000,   // poll every 60 seconds
  dbPath: './kyt-sdk.db',

  webhookUrl: process.env['WEBHOOK_URL'], // optional
});

// ----------------------------------------------------------
// 2. Subscribe to events
// ----------------------------------------------------------

sdk.on('transaction.detected', ({ transaction }) => {
  console.log(`[DETECTED] ${transaction.tokenSymbol} on ${transaction.chain} — tx ${transaction.txHash}`);
});

sdk.on('kyt.passed', ({ transaction, score }) => {
  console.log(`[KYT PASS] sender ${transaction.sender} scored ${score} — forwarding funds`);
});

sdk.on('kyt.blocked', ({ transaction, score }) => {
  console.warn(`[KYT BLOCK] sender ${transaction.sender} scored ${score} — funds held on tracking wallet`);
  console.warn(`  Tracking wallet: ${transaction.chain === 'tron' ? 'TRON' : 'EVM'} address`);
});

sdk.on('transfer.completed', ({ chain, txHash, token, amount }) => {
  console.log(`[FORWARDED] ${token} on ${chain} — tx ${txHash}`);
});

sdk.on('gas.swept', ({ chain, amount, txHash }) => {
  console.log(`[GAS] Topped up tracking wallet on ${chain} with ${amount} wei — tx ${txHash}`);
});

sdk.on('error', ({ error, context }) => {
  console.error(`[ERROR] ${context}: ${error.message}`);
});

// ----------------------------------------------------------
// 3. Create a tracking wallet
// ----------------------------------------------------------

await sdk.initialize();

const wallet = await sdk.createTrackingWallet({
  chains:             ['ethereum', 'arbitrum', 'base'],
  destinationAddress: '0xYourDestinationWalletAddress',
  label:              'order-12345',
  riskThreshold:      40, // stricter than global default
});

console.log('\nTracking wallet created:');
console.log('  ID:          ', wallet.id);
console.log('  EVM Address: ', wallet.evmAddress);
console.log('  Chains:      ', wallet.chains.join(', '));
console.log('  Polling:     ', wallet.pollingIntervalMs, 'ms');
console.log('\nSend USDT or USDC to', wallet.evmAddress, 'on any of the configured chains.');
console.log('The SDK will automatically detect the transfer, run a KYT check on the sender,');
console.log('and forward compliant funds to your destination wallet.\n');

// ----------------------------------------------------------
// 4. Manual transfer example (admin)
// ----------------------------------------------------------

// Move accidentally received funds or blocked funds that you've reviewed:
// const result = await sdk.manualTransfer({
//   walletIndex:        wallet.index,
//   chain:              'ethereum',
//   destinationAddress: '0xYourDestinationWalletAddress',
//   tokenAddress:       '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
//   // amount: 1_000_000n, // omit to transfer full balance
// });
// console.log('Manual transfer tx:', result.txHash);

// ----------------------------------------------------------
// 5. Keep running until SIGINT
// ----------------------------------------------------------

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await sdk.shutdown();
  process.exit(0);
});

// Prevent process from exiting
await new Promise(() => {});
