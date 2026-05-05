/**
 * HashiCorp Vault secrets provider example.
 *
 * Secrets are stored in Vault's KV v2 engine.  The SDK fetches them at runtime
 * using a Vault token, AppRole, or any auth method that produces a token.
 *
 * Prerequisites:
 *   1. Start Vault and enable the KV v2 secrets engine:
 *        vault secrets enable -path=secret kv-v2
 *   2. Store your secrets:
 *        vault kv put secret/kyt-sdk \
 *          KYT_MASTER_SEED="your_64_char_hex_seed" \
 *          KYT_GAS_RESERVE_KEY="your_private_key" \
 *          KYT_ALPHA_AML_API_KEY="your_api_key" \
 *          KYT_WEBHOOK_SECRET="your_webhook_secret"
 *   3. Create a policy that allows read on the path and attach it to an AppRole.
 *   4. Set VAULT_ADDR and VAULT_TOKEN (or use AppRole login to get a token).
 */
import 'dotenv/config';
import { KytSDK, VaultSecretsProvider } from '../src/index.js';

const sdk = new KytSDK({
  chains: {
    ethereum: { rpcUrl: process.env['ETH_RPC_URL'] ?? '' },
    bsc:      { rpcUrl: process.env['BSC_RPC_URL'] ?? '' },
  },

  secrets: new VaultSecretsProvider({
    addr:  process.env['VAULT_ADDR'],        // e.g. https://vault.example.com:8200
    token: process.env['VAULT_TOKEN'],       // root token or AppRole secret-id exchange
    path:  'secret/kyt-sdk',                // mount/secret-name

    // Optional — for Vault Enterprise or HCP Vault namespaces
    namespace: process.env['VAULT_NAMESPACE'],

    // Optional — override the field names inside the secret object
    fields: {
      masterSeed:     'KYT_MASTER_SEED',
      gasReserveKey:  'KYT_GAS_RESERVE_KEY',
      alphaAmlApiKey: 'KYT_ALPHA_AML_API_KEY',
      webhookSecret:  'KYT_WEBHOOK_SECRET',
    },
  }),

  riskThreshold:     50,
  pollingIntervalMs: 60_000,
  webhookUrl:        process.env['WEBHOOK_URL'],
});

sdk.on('transaction.detected', ({ transaction }) =>
  console.log(`Detected ${transaction.tokenSymbol} transfer — tx ${transaction.txHash}`));
sdk.on('kyt.passed',  ({ transaction, score }) =>
  console.log(`KYT passed (score ${score}): forwarding ${transaction.tokenSymbol}`));
sdk.on('kyt.blocked', ({ transaction, score }) =>
  console.warn(`KYT blocked (score ${score}): ${transaction.sender} on ${transaction.chain}`));
sdk.on('transfer.completed', ({ txHash, token }) =>
  console.log(`Forwarded ${token} — tx ${txHash}`));
sdk.on('error', ({ error, context }) =>
  console.error(`Error [${context}]:`, error.message));

await sdk.initialize();

// Example: create wallets for multiple orders
const orders = ['INV-001', 'INV-002', 'INV-003'];
for (const orderId of orders) {
  const wallet = await sdk.createTrackingWallet({
    chains:             ['ethereum', 'bsc'],
    destinationAddress: process.env['DESTINATION_ADDRESS'] ?? '',
    label:              orderId,
  });
  console.log(`${orderId} → wallet ${wallet.evmAddress}`);
}

process.on('SIGINT', async () => { await sdk.shutdown(); process.exit(0); });
await new Promise(() => {});
