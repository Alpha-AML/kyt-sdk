# Quick Start

## Requirements

- **Node.js ≥ 20**
- **Alpha AML API key** — obtain from [alpha-aml.com](https://alpha-aml.com)
- **RPC endpoint** for each chain you want to monitor — any standard JSON-RPC provider works: [Alchemy](https://www.alchemy.com), [Infura](https://infura.io), [QuickNode](https://www.quicknode.com), or your own node. Tron uses [TronGrid](https://trongrid.io).
- **Gas reserve wallet** — a dedicated wallet pre-funded with native tokens (ETH on Ethereum/Arbitrum/Base, BNB on BSC, TRX on Tron). The SDK uses it to pay gas when forwarding stablecoins from tracking wallets.

## Installation

```bash
npm install @alpha-aml/kyt-sdk
```

## 1. Generate a master seed

The master seed controls all derived tracking wallets.  Store it in your KMS — never in plaintext on disk.

```ts
import { KytSDK } from '@alpha-aml/kyt-sdk';

// Option A — random 32-byte seed (hex)
const seed = KytSDK.generateSeed();
console.log(seed); // store this in AWS KMS / HashiCorp Vault

// Option B — BIP39 mnemonic (24 words, easier to back up)
const mnemonic = KytSDK.generateMnemonic();
const seed2    = KytSDK.mnemonicToSeed(mnemonic); // convert to hex seed
```

## 2. Configure the SDK

```ts
import { KytSDK, EnvSecretsProvider } from '@alpha-aml/kyt-sdk';

const sdk = new KytSDK({
  // RPC endpoints — provide your own (Alchemy, Infura, QuickNode, etc.)
  chains: {
    ethereum: { rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY' },
    arbitrum: { rpcUrl: 'https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY' },
    base:     { rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY' },
    bsc:      { rpcUrl: 'https://bsc-dataseed.binance.org' },
    tron:     { rpcUrl: 'https://api.trongrid.io', tronGridApiKey: 'YOUR_KEY' },
  },

  // Secrets provider — see docs/security.md for production options
  secrets: new EnvSecretsProvider(),

  riskThreshold:     50,        // block transactions where sender score > 50
  pollingIntervalMs: 60_000,    // check for new transactions every 60 s
  confirmationsRequired: 20,    // wait 20 blocks before processing

  dbPath:     './kyt-sdk.db',   // SQLite state file
  webhookUrl: 'https://your-server.example.com/webhooks/kyt', // optional
});
```

Set the required environment variables (copy `.env.example` → `.env`):

```bash
KYT_MASTER_SEED=<64-char hex seed>
KYT_GAS_RESERVE_KEY=<64-char hex private key>
KYT_ALPHA_AML_API_KEY=<your api key>
```

## 3. Listen to events and start

```ts
sdk.on('kyt.passed', ({ transaction, score }) => {
  console.log(`Sender ${transaction.sender} passed KYT (score ${score}). Forwarding...`);
});

sdk.on('kyt.blocked', ({ transaction, score }) => {
  console.warn(`Sender ${transaction.sender} BLOCKED (score ${score}). Funds held.`);
});

sdk.on('transfer.completed', ({ txHash, token, amount }) => {
  console.log(`Forwarded ${token} — tx ${txHash}`);
});

sdk.on('error', ({ error, context }) => {
  console.error(`[${context}]`, error.message);
});

await sdk.initialize();
```

## 4. Create a tracking wallet

```ts
const wallet = await sdk.createTrackingWallet({
  chains:             ['ethereum', 'arbitrum'],
  destinationAddress: '0xYourTreasuryWallet',
  label:              'invoice-1001',  // optional reference
});

console.log('Payment address:', wallet.evmAddress);
// Send USDT or USDC to this address. The SDK does the rest.
```

## 5. Handle blocked funds (manual transfer)

When a transaction is blocked by KYT, funds remain on the tracking wallet.  After your compliance review, you can release or redirect them:

```ts
await sdk.manualTransfer({
  walletIndex:        wallet.index,
  chain:              'ethereum',
  destinationAddress: '0xComplianceEscrowWallet',
  tokenAddress:       '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  // amount: 1_000_000n,  // omit to transfer full balance
});
```

## 6. Shutdown cleanly

```ts
process.on('SIGINT', async () => {
  await sdk.shutdown();
  process.exit(0);
});
```

---

Next: [API Reference](./api-reference.md) | [Security Guide](./security.md) | [Architecture](./architecture.md)
