# CoinsPaid Integration

Three-layer B2B stablecoin payment flow built on top of the KYT SDK.

```
User
  └─→  Buffer Wallet 1  →  AML check  →  CoinsPaid     (Layer 1 — cp:deposit)
                                              │
                                              ▼
                                         Buffer Wallet 2  →  AML check  →  Destination
                                                                            (Layer 2 — cp:withdraw)
```

Each layer runs an independent AML check. Funds stay on the buffer wallet on any error — they are never lost.

---

## Prerequisites

### 1. HashiCorp Vault

All secrets must be stored in Vault. The scripts will not read private keys or API credentials from `.env`.

Required Vault keys (default field names, configurable in each script):

| Vault key              | Description                                    |
|------------------------|------------------------------------------------|
| `KYT_MASTER_SEED`      | 64-char hex seed for HD wallet derivation      |
| `KYT_GAS_RESERVE_KEY`  | Private key of the gas reserve wallet          |
| `KYT_ALPHA_AML_API_KEY`| Alpha AML API key                              |
| `KYT_WEBHOOK_SECRET`   | HMAC secret for SDK webhook signature checks   |
| `COINSPAID_API_KEY`    | CoinsPaid API key                              |
| `COINSPAID_API_SECRET` | CoinsPaid API secret                           |

`.env` must contain Vault connection details:

```env
VAULT_ADDR=https://vault.example.com:8200
VAULT_TOKEN=hvs.xxxx
VAULT_PATH=kyt-sdk/prod
```

### 2. Two webhook URLs

| URL | Direction | Purpose |
|-----|-----------|---------|
| `PAYMENT_WEBHOOK_URL` | Outbound (our scripts → your server) | Business events: deposit detected, AML result, transfer complete |
| CoinsPaid webhook URL | Inbound (CoinsPaid → your server) | CoinsPaid confirms deposit received |

Both must be reachable HTTPS endpoints. For local testing use [pipedream.com](https://pipedream.com) or [requestbin.com](https://requestbin.com).

The deposit script starts an HTTP server on `COINSPAID_WEBHOOK_PORT` (default `3000`) to receive CoinsPaid callbacks. Point CoinsPaid to `https://your-server.com/webhook/coinspaid`.

```env
PAYMENT_WEBHOOK_URL=https://your-server.com/webhooks/payment
COINSPAID_WEBHOOK_PORT=3000
COINSPAID_API_URL=https://app.cryptoprocessing.com/api/v2
COINSPAID_COMPANY_NAME=ACME-CORP
COINSPAID_COMPANY_COUNTRY=EST
```

### 3. RPC URLs

```env
ETH_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
ARB_RPC_URL=https://arb1.arbitrum.io/rpc
BASE_RPC_URL=https://mainnet.base.org
BSC_RPC_URL=https://bsc-dataseed.binance.org
TRON_RPC_URL=https://api.trongrid.io
# Testnets
ETH_SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
ARB_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
```

---

## Supported Chains and Tokens

| Chain | `--chain` value | Stablecoins | Native (gas) |
|-------|----------------|-------------|--------------|
| Ethereum | `ethereum` | USDT, USDC | ETH |
| Arbitrum | `arbitrum` | USDT, USDC, USDC.e | ETH |
| Base | `base` | USDC, USDbC, USDT | ETH |
| BNB Smart Chain | `bsc` | USDT | BNB |
| Tron | `tron` | USDT, USDC | TRX |
| Ethereum Sepolia *(testnet)* | `ethereum-sepolia` | USDC, USDT | ETH |
| Arbitrum Sepolia *(testnet)* | `arbitrum-sepolia` | USDC | ETH |

CoinsPaid testnet monitors **Ethereum Sepolia** (USDTE) and **Arbitrum Sepolia** (USDCA). Use these chains for sandbox testing.

---

## Scripts

### `init:gas` — Initialise Gas Reserve Wallets

Derives gas wallet addresses from your master seed and prints them. Send native tokens (ETH, BNB, TRX) to these addresses before running any payment flows.

```bash
npm run init:gas
```

Output:
```
Gas reserve wallets
  ethereum  : 0x...
  arbitrum  : 0x...
  base      : 0x...
  bsc       : 0x...
  tron      : T...
```

Fund the wallets for every chain you intend to use. The gas manager tops up buffer wallets automatically from here before each forward transaction.

**Sends webhook event:** `gas_wallet_ready`

---

### `cp:deposit` — Layer 1: Receive User Deposit → Forward to CoinsPaid

Creates a buffer wallet, gives the user a deposit address, monitors for incoming stablecoins, runs AML, and forwards passing funds to a CoinsPaid address.

```bash
npm run cp:deposit -- \
  --chain            ethereum-sepolia \
  --expected-amount  100 \
  --customer-id      cust-0x1234 \
  --confirmations    1
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--chain` | yes | Chain to use (see table above) |
| `--expected-amount` | yes | Expected deposit in USD |
| `--customer-id` | yes | Your internal customer/company ID (sent to CoinsPaid as `end_user_reference`) |
| `--confirmations` | no | Blocks to wait before AML (default 20, use 1 on testnet) |
| `--threshold` | no | AML risk score cutoff 0–100 (default 50) |

The script starts a CoinsPaid webhook listener and prints:

```
DEPOSIT HERE → 0x...BufferWallet1...

After deposit is confirmed run:
  npm run cp:withdraw -- \
    --coinspaid-address 0x...CoinsPaidAddress... \
    --destination 0x...YourDestination... \
    --amount 100.00000000 \
    --chain ethereum-sepolia \
    --confirmations 1
```

**AML block:** if the AML score exceeds the threshold the script shuts down immediately. It prints the wallet address, the score, and an exact `manual:transfer` recovery command to return funds to the sender.

**Other errors (gas, SDK):** funds stay on buffer wallet 1 and a recovery command is printed. The error is also posted to `PAYMENT_WEBHOOK_URL`.

**Sends webhook events:** `deposit_address_ready`, `deposit_detected`, `aml_passed`, `aml_blocked`, `coinspaid_forwarded`, `coinspaid_deposit_confirmed`, `error`

---

### `cp:withdraw` — Layer 2: Withdraw from CoinsPaid → Final Destination

Initiates a CoinsPaid withdrawal to a second buffer wallet, runs AML on the CoinsPaid sender address, then forwards to the final destination.

Run this using the command printed by `cp:deposit` after it completes.

```bash
npm run cp:withdraw -- \
  --coinspaid-address 0x...CoinsPaidDepositAddress... \
  --destination       0x...FinalDestinationWallet... \
  --amount            100.00000000 \
  --chain             ethereum-sepolia \
  --confirmations     1
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--coinspaid-address` | yes | CoinsPaid deposit address (from `deposit:coinspaid` output) |
| `--destination` | yes | Final destination wallet |
| `--amount` | yes | Amount to withdraw (must match what CoinsPaid holds) |
| `--chain` | no | Auto-detected from DB; override if needed |
| `--confirmations` | no | Blocks before AML (default 20, use 1 on testnet) |
| `--threshold` | no | AML risk score cutoff 0–100 (default 50) |
| `--currency` | no | CoinsPaid currency code override (auto-detected from DB) |

Only the expected token (derived from the CoinsPaid currency code) is processed. Any unexpected tokens arriving on the buffer wallet are silently ignored.

**Error policy:** on any error funds stay on buffer wallet 2. A recovery command is printed and posted to `PAYMENT_WEBHOOK_URL`.

**Sends webhook events:** `coinspaid_withdrawal_initiated`, `l2_deposit_detected`, `aml_passed`, `aml_blocked`, `transfer_completed`, `error`

---

### `manual:transfer` — Emergency Fund Recovery

Transfers all stablecoin balances from a buffer wallet to any destination and marks the wallet as paused so it is never re-monitored. Use this when a payment failed mid-flow and funds are stuck.

```bash
# List all buffer wallets
npm run manual:transfer -- --list

# Transfer all tokens from a specific wallet
npm run manual:transfer -- \
  --from  0x...BufferWallet... \
  --to    0x...Destination... \
  --chain ethereum-sepolia
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--from` | yes (unless `--list`) | Buffer wallet EVM/Tron address |
| `--to` | yes | Destination address |
| `--chain` | yes | Chain the wallet is on |
| `--list` | — | Print all buffer wallets and exit |

After a successful transfer (or if the wallet is already empty) the wallet is marked `paused` in the database and will not be reloaded on the next run.

**Sends webhook events:** `manual_transfer_completed` per token, `error/manual_transfer_failed` on failure.

---

## Webhook Events (`PAYMENT_WEBHOOK_URL`)

All events are POSTed as JSON. Every payload includes a `timestamp` (ISO 8601) field.

### Deposit flow (Layer 1 — cp:deposit)

| `event` | When |
|---------|------|
| `deposit_address_ready` | Buffer wallet 1 created, ready to receive |
| `deposit_detected` | Stablecoin transfer detected on buffer wallet 1 |
| `aml_passed` | AML score below threshold (`layer: "L1"`) |
| `aml_blocked` | AML score above threshold — funds held on buffer wallet 1 |
| `coinspaid_forwarded` | Funds sent from buffer wallet 1 → CoinsPaid |
| `coinspaid_deposit_confirmed` | CoinsPaid webhook confirmed receipt |
| `error` | Any failure — includes `error_type`, `message`, recovery address |

### Withdrawal flow (Layer 2 — cp:withdraw)

| `event` | When |
|---------|------|
| `coinspaid_withdrawal_initiated` | CoinsPaid withdrawal to buffer wallet 2 started |
| `l2_deposit_detected` | Funds arrived at buffer wallet 2 from CoinsPaid |
| `aml_passed` | AML score below threshold (`layer: "L2"`) |
| `aml_blocked` | AML score above threshold — funds held on buffer wallet 2 |
| `transfer_completed` | Funds forwarded from buffer wallet 2 → destination |
| `error` | Any failure — includes `error_type`, `message`, recovery address |

### Other

| `event` | Source |
|---------|--------|
| `gas_wallet_ready` | `init:gas` |
| `manual_transfer_completed` | `manual:transfer` (per token) |
| `error/manual_transfer_failed` | `manual:transfer` |

---

## Example Webhook Payloads

All payloads are POSTed as `application/json`. Every object includes `timestamp` (ISO 8601).

**`deposit_address_ready`**
```json
{
  "event": "deposit_address_ready",
  "message": "Client should deposit here",
  "wallet_address": "0xBufferWallet1",
  "chain": "ethereum-sepolia",
  "tokens": [{ "symbol": "USDT", "address": "0x7169D38820dfd117C3FA1f22a697dBA58d90BA06" }],
  "expected_amount": 100,
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:00:00.000Z"
}
```

**`deposit_detected`**
```json
{
  "event": "deposit_detected",
  "tx_hash": "0xabc123...",
  "amount": "100.0 USDT",
  "token": "USDT",
  "from": "0xUserWallet",
  "chain": "ethereum-sepolia",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:01:00.000Z"
}
```

**`aml_passed`**
```json
{
  "event": "aml_passed",
  "layer": "L1",
  "score": 12,
  "risk_level": "VERY LOW RISK",
  "tx_hash": "0xabc123...",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:02:00.000Z"
}
```

**`aml_blocked`**
```json
{
  "event": "aml_blocked",
  "layer": "L1",
  "score": 87,
  "risk_level": "HIGH RISK",
  "tx_hash": "0xabc123...",
  "customer_id": "cust-0x1234",
  "wallet": "0xBufferWallet1",
  "note": "Sanctioned address",
  "timestamp": "2025-01-15T10:02:00.000Z"
}
```

**`coinspaid_forwarded`**
```json
{
  "event": "coinspaid_forwarded",
  "tx_hash": "0xdef456...",
  "coinspaid_address": "0xCoinsPaidDepositAddress",
  "cp_currency": "USDTE",
  "token": "USDT",
  "amount": "100.0 USDT",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:03:00.000Z"
}
```

**`coinspaid_deposit_confirmed`**
```json
{
  "event": "coinspaid_deposit_confirmed",
  "coinspaid_address": "0xCoinsPaidDepositAddress",
  "cp_currency": "USDTE",
  "amount": "100.00",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:05:00.000Z"
}
```

**`coinspaid_withdrawal_initiated`**
```json
{
  "event": "coinspaid_withdrawal_initiated",
  "coinspaid_withdrawal_id": 132544089,
  "coinspaid_address": "0xCoinsPaidDepositAddress",
  "to_address": "0xBufferWallet2",
  "currency": "USDTE",
  "amount": "100.00000000",
  "destination": "0xFinalDestination",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:10:00.000Z"
}
```

**`l2_deposit_detected`**
```json
{
  "event": "l2_deposit_detected",
  "tx_hash": "0xghi789...",
  "amount": "100.0 USDT",
  "token": "USDT",
  "from": "0xCoinsPaidHotWallet",
  "chain": "ethereum-sepolia",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:11:00.000Z"
}
```

**`transfer_completed`**
```json
{
  "event": "transfer_completed",
  "tx_hash": "0xjkl012...",
  "amount": "100.0 USDT",
  "token": "USDT",
  "destination": "0xFinalDestination",
  "chain": "ethereum-sepolia",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:12:00.000Z"
}
```

**`error`** (any layer)
```json
{
  "event": "error",
  "error_type": "gas_reserve_insufficient",
  "chain": "Ethereum Sepolia",
  "gas_wallet": "0xGasReserveWallet",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:02:00.000Z"
}
```

```json
{
  "event": "error",
  "error_type": "sdk_error",
  "context": "forward_funds",
  "message": "ERC20: transfer amount exceeds balance",
  "wallet": "0xBufferWallet1",
  "destination": "0xFinalDestination",
  "customer_id": "cust-0x1234",
  "timestamp": "2025-01-15T10:03:00.000Z"
}
```

**`manual_transfer_completed`**
```json
{
  "event": "manual_transfer_completed",
  "tx_hash": "0xmno345...",
  "amount": "100.0 USDT",
  "token": "USDT",
  "from": "0xBufferWallet1",
  "to": "0xDestination",
  "chain": "ethereum-sepolia",
  "timestamp": "2025-01-15T11:00:00.000Z"
}
```

---

## Library Files (`lib/`)

### `lib/coinspaid.client.ts`

Typed CoinsPaid API client. Handles request signing (HMAC-SHA512), address creation, withdrawals, currency list, and webhook signature verification.

Key exports:
- `CoinsPaidClient` — the API client class
- `resolveCpCurrency(chain, tokenSymbol)` — maps e.g. `('arbitrum', 'USDT')` → `'USDTA'`
- `reverseResolveCpCurrency(chain, cpCurrency)` — reverse: `('arbitrum', 'USDTA')` → `'USDT'`
- `COINSPAID_CURRENCY` — full chain → token → CoinsPaid code mapping

### `lib/coinspaid.storage.ts`

SQLite persistence for payment records (uses the same `kyt-sdk.db` as the SDK). Tracks two tables:

- `coinspaid_payments` — one row per payment session (customer ID, chain, status, wallet IDs)
- `coinspaid_addresses` — one row per token per payment (CoinsPaid address, amounts, withdrawal ID, status)

The withdrawal script looks up the payment record by CoinsPaid deposit address to auto-detect chain, currency, and customer ID — which is why `cp:deposit` must run first.

### `lib/payment_webhook.ts`

Thin wrapper around `fetch` that posts JSON to `PAYMENT_WEBHOOK_URL`. Non-blocking: a failed POST logs a warning but never interrupts the payment flow. Retries automatically on HTTP 429 (rate limit) with 1s → 2s → 4s backoff.
