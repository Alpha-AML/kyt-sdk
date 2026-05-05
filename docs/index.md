# Alpha AML KYT SDK

Know-Your-Transaction compliance automation for B2B stablecoin payments.

## What it does

The KYT SDK monitors incoming USDT / USDC / BUSD transfers on Ethereum, Arbitrum, Base, BSC, and Tron.  When a new transfer is detected, it automatically:

1. Extracts the **sender address** from the on-chain Transfer event log
2. Queries the **Alpha AML risk API** to score the sender address
3. **Forwards** compliant funds to your treasury wallet
4. **Holds** high-risk funds on the tracking wallet and notifies you via webhook or event handler

No manual intervention is required for clean transactions.  Blocked transactions remain safely isolated on the tracking wallet until a compliance officer reviews them.

## Documentation

| Document | Description |
|---|---|
| [Quick Start](./quick-start.md) | Install, configure, and receive your first payment |
| [API Reference](./api-reference.md) | Complete SDK method and type reference |
| [Architecture](./architecture.md) | Component diagram, state machine, token flow, HD derivation |
| [Security Guide](./security.md) | Secrets management, key rotation, operational hardening |

## Diagrams

| Diagram | Description |
|---|---|
| [Token Flow](./diagrams/token-flow.mmd) | How tokens move from sender to tracking wallet to destination |
| [KYT Sequence](./diagrams/kyt-flow.mmd) | Step-by-step KYT check and forwarding sequence |
| [HD Derivation](./diagrams/hd-derivation.mmd) | Master seed → tracking wallet derivation tree |

## Key design decisions

**One master seed.** A single BIP32/BIP44 root key derives unlimited tracking wallets.  The client stores one secret; the SDK handles all derivation.

**Hold-everything rule.** If a tracking wallet receives multiple transfers from different senders, forwarding does not begin until every pending KYT check resolves.  This prevents partial forwarding of mixed clean/blocked batches.

**No infrastructure required.** The SDK uses SQLite for persistence and direct RPC calls for chain interactions.  No message broker, cache server, or blockchain node is required beyond the RPC endpoint.

**Secure by default.** Private keys are derived on-demand and never persisted.  Webhook payloads are signed with HMAC-SHA256.  Gas reserve balances are validated before each sweep.

## Supported chains and tokens

| Chain | Stablecoins |
|---|---|
| Ethereum | USDT, USDC |
| Arbitrum One | USDT, USDC, USDC.e |
| Base | USDC, USDbC, USDT |
| BNB Smart Chain | USDT, BUSD, USDC |
| Tron | USDT, USDC |
