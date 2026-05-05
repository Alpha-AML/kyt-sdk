# Alpha AML KYT SDK

Know-Your-Transaction compliance automation for B2B stablecoin payments on Ethereum, Arbitrum, Base, BSC, and Tron.

The SDK monitors incoming USDT/USDC transfers to HD-derived tracking wallets, runs KYT checks against the Alpha AML API, and automatically forwards compliant funds to your destination wallet — no manual intervention required for clean transactions.

## Requirements

- **Node.js ≥ 20**
- **Alpha AML API key** — issued from your [alpha-aml.com](https://alpha-aml.com) dashboard
- **RPC endpoint** for each chain you monitor — any standard JSON-RPC provider works (Alchemy, Infura, QuickNode, your own node, etc.)
- **Gas reserve wallet** — a dedicated wallet pre-funded with native tokens (ETH, BNB, TRX) on each chain; the SDK uses it to pay gas when forwarding stablecoins

## Installation

```bash
npm install @alpha-aml/kyt-sdk
```

## Quick example

```ts
import { KytSDK, EnvSecretsProvider } from '@alpha-aml/kyt-sdk';

const sdk = new KytSDK({
  chains: {
    ethereum: { rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY' },
    tron:     { rpcUrl: 'https://api.trongrid.io', tronGridApiKey: 'YOUR_KEY' },
  },
  secrets:       new EnvSecretsProvider(),
  riskThreshold: 50,           // block senders with score > 50
  dbPath:        './kyt.db',
});

await sdk.initialize();

const wallet = await sdk.createTrackingWallet({
  chains:             ['ethereum'],
  destinationAddress: '0xYourTreasury',
});

console.log('Send USDT/USDC to:', wallet.evmAddress);
// SDK handles KYT checks and forwarding automatically
```

Copy `.env.example` → `.env` and fill in `KYT_MASTER_SEED`, `KYT_GAS_RESERVE_KEY`, and `KYT_ALPHA_AML_API_KEY`.

## Documentation

| Document | Description |
|---|---|
| [Quick Start](./docs/quick-start.md) | Step-by-step setup and first payment |
| [API Reference](./docs/api-reference.md) | All methods, types, and events |
| [Architecture](./docs/architecture.md) | State machine, token flow, HD derivation |
| [Security Guide](./docs/security.md) | Secrets management, key storage, hardening |

## How it works

1. The SDK derives tracking wallets from a single BIP32/BIP44 master seed — one seed controls unlimited wallets.
2. When a stablecoin transfer arrives, the sender address is extracted from the on-chain Transfer log and checked against the Alpha AML API.
3. If the risk score is within threshold, the SDK automatically tops up gas (if needed) and forwards the tokens to your destination wallet.
4. High-risk transactions are held on the tracking wallet and flagged via events/webhooks for compliance review.

## Supported chains and tokens

| Chain | Stablecoins |
|---|---|
| Ethereum | USDT, USDC |
| Arbitrum One | USDT, USDC, USDC.e |
| Base | USDC, USDbC, USDT |
| BNB Smart Chain | USDT, BUSD, USDC |
| Tron | USDT, USDC |
