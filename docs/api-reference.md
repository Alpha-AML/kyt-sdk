# API Reference

## `KytSDK`

The main class.  All methods are available after calling `initialize()`.

### Constructor

```ts
new KytSDK(config: KytSdkConfig)
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `chains` | `Partial<Record<SupportedChain, ChainRpcConfig>>` | ✓ | — | RPC endpoints per chain |
| `secrets` | `SecretsProvider` | ✓ | — | Secrets provider instance |
| `riskThreshold` | `number` | | `50` | Score above which transactions are blocked (0–100) |
| `pollingIntervalMs` | `number` | | `60000` | Polling interval in milliseconds |
| `confirmationsRequired` | `number` | | `20` | Block confirmations before processing |
| `dbPath` | `string` | | `./kyt-sdk.db` | SQLite database file path |
| `webhookUrl` | `string` | | — | HTTP endpoint to receive event notifications |
| `gas` | `Partial<Record<SupportedChain, GasConfig>>` | | — | Per-chain gas management overrides |
| `tokens` | `Partial<Record<SupportedChain, TokenConfig[]>>` | | — | Replace default token list per chain |
| `additionalTokens` | `Partial<Record<SupportedChain, TokenConfig[]>>` | | — | Add tokens to defaults per chain |

### `ChainRpcConfig`

```ts
interface ChainRpcConfig {
  rpcUrl:         string;   // HTTP(S) RPC endpoint
  explorerApiKey?: string;  // optional Etherscan-compatible key
  tronGridApiKey?: string;  // optional TronGrid API key (Tron only)
}
```

### `GasConfig`

```ts
interface GasConfig {
  minBalanceWei?:  bigint;  // trigger top-up when below this amount
  topUpAmountWei?: bigint;  // amount to sweep from reserve per top-up
}
```

---

### Lifecycle

#### `sdk.initialize(): Promise<void>`

Loads the master seed, opens the SQLite database, resolves chain clients, and starts monitoring all previously active tracking wallets.  Must be called before any other method.

#### `sdk.shutdown(): Promise<void>`

Stops all polling timers, closes the database, and removes all event listeners.  Call on process exit.

---

### Wallet management

#### `sdk.createTrackingWallet(options): Promise<TrackingWallet>`

Derives a new HD wallet and begins monitoring it for incoming stablecoin transfers.

```ts
interface CreateTrackingWalletOptions {
  chains:             SupportedChain[];  // chains to monitor
  destinationAddress: string;            // where to forward approved funds
  index?:             number;            // HD derivation index (auto if omitted)
  riskThreshold?:     number;            // override global threshold
  pollingIntervalMs?: number;            // override global polling interval
  label?:             string;            // human-readable reference
}
```

Returns:

```ts
interface TrackingWallet {
  id:                 string;
  index:              number;
  evmAddress?:        string;  // present when any EVM chain is monitored
  tronAddress?:       string;  // present when Tron is monitored
  chains:             SupportedChain[];
  destinationAddress: string;
  riskThreshold:      number;
  pollingIntervalMs:  number;
  label?:             string;
  status:             'active' | 'paused' | 'closed';
  createdAt:          Date;
}
```

**Throws** if:
- A chain in `chains` is not in `config.chains`
- `destinationAddress` fails format validation for the selected chains
- `index` is already used by another wallet

#### `sdk.getTrackingWallet(id: string): TrackingWallet | undefined`

#### `sdk.listTrackingWallets(): TrackingWallet[]`

Returns all wallets ordered by derivation index.

#### `sdk.pauseTrackingWallet(id: string): void`

Stops polling for the wallet without deleting its state.  Any in-flight transactions are preserved and resume when the wallet is resumed.

#### `sdk.resumeTrackingWallet(id: string): void`

#### `sdk.getTransactions(walletId: string): DetectedTransaction[]`

Returns all detected transactions for a wallet, ordered by detection time.

#### `sdk.getPendingTransactions(walletId: string): DetectedTransaction[]`

Returns transactions that have not yet reached a terminal state.

---

### Manual transfer

#### `sdk.manualTransfer(options): Promise<ManualTransferResult>`

Transfers tokens or native currency from a derived HD wallet to any destination.  Use this to:

- Move accidentally received funds (wrong token, wrong chain)
- Release blocked funds after compliance review

```ts
interface ManualTransferOptions {
  walletIndex:        number;    // HD derivation index
  chain:              SupportedChain;
  destinationAddress: string;
  tokenAddress?:      string;    // ERC-20 / TRC-20 contract; omit for native
  amount?:            bigint;    // smallest unit; omit to transfer full balance
}

interface ManualTransferResult {
  txHash:      string;
  amount:      bigint;
  tokenSymbol: string;
  chain:       SupportedChain;
}
```

---

### Events

#### `sdk.on(event, handler): void`
#### `sdk.off(event, handler): void`

```ts
sdk.on('transaction.detected',  ({ transaction }) => { ... });
sdk.on('transaction.confirmed', ({ transaction }) => { ... });
sdk.on('kyt.checking',          ({ transaction, sender }) => { ... });
sdk.on('kyt.passed',            ({ transaction, score, report }) => { ... });
sdk.on('kyt.blocked',           ({ transaction, score, report }) => { ... });
sdk.on('transfer.initiated',    ({ walletId, chain, token, amount, destination }) => { ... });
sdk.on('transfer.completed',    ({ walletId, chain, txHash, token, amount }) => { ... });
sdk.on('gas.low',               ({ walletId, chain, currentBalance, required }) => { ... });
sdk.on('gas.swept',             ({ walletId, chain, amount, txHash }) => { ... });
sdk.on('error',                 ({ error, walletId, chain, context }) => { ... });
```

The same events are delivered to the configured webhook URL as JSON POST requests.  See [Webhooks](#webhooks) below.

---

### Static utilities

#### `KytSDK.generateSeed(): string`

Returns a cryptographically random 32-byte hex seed (64 characters).

#### `KytSDK.generateMnemonic(): string`

Returns a BIP39 24-word mnemonic (256 bits of entropy).

#### `KytSDK.mnemonicToSeed(mnemonic, passphrase?): string`

Converts a BIP39 mnemonic to a 64-byte hex seed.  Throws on invalid input.

---

### Webhooks

Each event is delivered as an HTTP POST with:

- `Content-Type: application/json`
- `X-KYT-Signature: <sha256-hmac-hex>` (when webhook secret is configured)

#### Payload schema

```json
{
  "event":     "kyt.blocked",
  "timestamp": "2026-05-05T12:00:00.000Z",
  "data": {
    "transaction": { ... },
    "score": 85,
    "report": { ... }
  }
}
```

BigInt values are serialised as decimal strings.

#### Verifying signatures

```ts
import { verifyWebhookSignature } from '@alpha-aml/kyt-sdk';

// Express.js example
app.post('/webhooks/kyt', express.text({ type: '*/*' }), (req, res) => {
  const valid = verifyWebhookSignature(
    req.body,
    req.headers['x-kyt-signature'],
    process.env.KYT_WEBHOOK_SECRET,
  );
  if (!valid) return res.status(401).send('Unauthorized');

  const payload = JSON.parse(req.body);
  // handle payload.event ...
  res.sendStatus(200);
});
```

---

### Supported chains and tokens

| Chain | SDK key | Default stablecoins |
|---|---|---|
| Ethereum | `ethereum` | USDT, USDC |
| Arbitrum One | `arbitrum` | USDT, USDC, USDC.e |
| Base | `base` | USDC, USDbC, USDT |
| BNB Smart Chain | `bsc` | USDT, BUSD, USDC |
| Tron | `tron` | USDT, USDC |

Override per-chain tokens via `config.tokens` or extend via `config.additionalTokens`.

### Supported chains for KYT

The Alpha AML `report-v1` endpoint is called with the chain identifier matching the transaction chain.  All five SDK chains are supported.
