# Security Guide

## Secrets management

The SDK never stores secrets in cleartext.  At startup, the `SecretsProvider` interface is called once per secret; the resolved values live in memory only for the duration of the process.

### Choosing a provider

| Provider | When to use |
|---|---|
| `EnvSecretsProvider` | Local development, quick integration testing |
| `AwsKmsSecretsProvider` | AWS-hosted deployments (Lambda, ECS, EC2) |
| `VaultSecretsProvider` | Multi-cloud or on-premises with HashiCorp Vault |
| Custom (implement `SecretsProvider`) | GCP Secret Manager, Azure Key Vault, HSM |

### Custom provider example

```ts
import type { SecretsProvider } from '@alpha-aml/kyt-sdk';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

class GcpSecretManagerProvider implements SecretsProvider {
  private readonly client = new SecretManagerServiceClient();

  async getMasterSeed() { return this.access('kyt-master-seed'); }
  async getGasReservePrivateKey() { return this.access('kyt-gas-reserve-key'); }
  async getAlphaAmlApiKey() { return this.access('kyt-alpha-aml-api-key'); }

  private async access(name: string): Promise<string> {
    const [version] = await this.client.accessSecretVersion({
      name: `projects/MY_PROJECT/secrets/${name}/versions/latest`,
    });
    return version.payload!.data!.toString();
  }
}
```

---

## Master seed

The master seed is the single root of trust for **all** derived tracking wallets.

- **Generate once, never regenerate.** Regenerating produces different wallet addresses — any funds sent to old addresses would be inaccessible.
- **Back up securely.** Store an encrypted copy in at least two geographically separate locations.
- **Rotate only as a planned migration.** Create new wallets under the new seed, drain existing wallets manually, then decommission the old seed.
- **Use BIP39** if you prefer human-readable backups: `KytSDK.generateMnemonic()` gives 24 words that can be stamped on metal and stored offline.

### HD derivation paths

```
EVM (Ethereum, Arbitrum, Base, BSC): m/44'/60'/0'/0/{index}
Tron:                                m/44'/195'/0'/0/{index}
```

The same `index` produces a different EVM address and a different Tron address (different coin-type path).  EVM wallets share the same address across all EVM chains.

---

## Gas reserve wallet

The gas reserve wallet funds tracking wallets with native tokens so they can pay gas for forwarding transactions.

- **Keep it funded.** The SDK checks reserve balance before each top-up and throws if reserve is insufficient.
- **Use a dedicated wallet.** Never reuse a hot wallet that holds user funds.
- **Monitor balance.** Subscribe to `gas.swept` events to track outflows.  Alert when balance drops below a safe threshold.
- **Per-chain funding.** The same EVM address is used across all EVM chains, but each chain requires its own native tokens (ETH on Ethereum/Arbitrum/Base, BNB on BSC).

---

## Tracking wallet security

- Tracking wallet private keys are derived on-demand from the master seed and are **never persisted** — they exist in memory only during a transfer operation.
- Funds on a tracking wallet are not at risk if the host process is compromised **unless** the attacker can read process memory to extract the in-flight private key or the master seed.  Use process isolation, SELinux/AppArmor, and memory encryption where available.
- **Do not reuse tracking wallet indices.** The SDK rejects duplicate indices at creation time.

---

## KYT check integrity

- The SDK enforces a mandatory KYT check on the **sender address extracted from on-chain logs** — the address that the blockchain records as the originating account.  This cannot be spoofed by the sender providing a false address.
- A transaction remains in `pending_kyt` state until the KYT check completes.  No forwarding occurs until the check resolves.
- **Hold-everything rule**: if any transaction on a tracking wallet is still pending, no forwarding of any token occurs.  This prevents partial forwarding of mixed clean/blocked batches.
- KYT results are cached for 5 minutes per address per chain to respect API rate limits.  Cache is bounded to 10 000 entries; expired entries are evicted automatically.

---

## Webhook security

Webhook payloads are signed with HMAC-SHA256 using your configured `webhookSecret`.  Always verify signatures on the receiver side:

```ts
import { verifyWebhookSignature } from '@alpha-aml/kyt-sdk';

const isValid = verifyWebhookSignature(rawBody, signature, secret);
```

The verification uses constant-time comparison to prevent timing attacks.

---

## Operational hardening

- Run the SDK process with minimal OS privileges (dedicated user, no root).
- Restrict outbound network access to only the RPC and Alpha AML API domains.
- Enable WAL mode in SQLite (done automatically by the SDK) for crash safety.
- Rotate the gas reserve wallet key periodically; the SDK picks up the new key from the secrets provider on the next cold start.
- Monitor the `error` event — persistent errors may indicate RPC failures, API key expiry, or gas shortfalls.
