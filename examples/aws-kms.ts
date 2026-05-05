/**
 * AWS KMS secrets provider example.
 *
 * In this setup, the master seed and gas reserve key are encrypted at rest
 * using AWS KMS.  The plaintext never touches disk or environment variables.
 *
 * Prerequisites:
 *   1. Create a KMS symmetric key in your AWS account.
 *   2. Encrypt each secret:
 *        aws kms encrypt \
 *          --key-id arn:aws:kms:us-east-1:ACCOUNT:key/KEY-ID \
 *          --plaintext fileb://<(echo -n "your_64_char_hex_seed") \
 *          --query CiphertextBlob --output text
 *   3. Store the base64 ciphertext blobs in environment variables (safe — encrypted).
 *   4. Ensure the Lambda/ECS task role has kms:Decrypt permission on the key.
 */
import 'dotenv/config';
import { KytSDK, AwsKmsSecretsProvider } from '../src/index.js';

const sdk = new KytSDK({
  chains: {
    ethereum: { rpcUrl: process.env['ETH_RPC_URL'] ?? '' },
    arbitrum: { rpcUrl: process.env['ARB_RPC_URL'] ?? '' },
  },

  secrets: new AwsKmsSecretsProvider({
    keyId: process.env['AWS_KMS_KEY_ID'] ?? '',

    kmsConfig: {
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      // Credentials resolve automatically from instance profile, ECS task role,
      // or ~/.aws/credentials — no need to hardcode them.
    },

    // Base64-encoded KMS ciphertexts.  Store these in env vars, config files,
    // or AWS Parameter Store — they are safe to commit (encrypted).
    encryptedMasterSeed:     process.env['KMS_ENCRYPTED_MASTER_SEED'] ?? '',
    encryptedGasReserveKey:  process.env['KMS_ENCRYPTED_GAS_RESERVE_KEY'] ?? '',
    encryptedAlphaAmlApiKey: process.env['KMS_ENCRYPTED_ALPHA_AML_API_KEY'] ?? '',
    encryptedWebhookSecret:  process.env['KMS_ENCRYPTED_WEBHOOK_SECRET'],
  }),

  riskThreshold:     50,
  pollingIntervalMs: 30_000,
  webhookUrl:        process.env['WEBHOOK_URL'],
});

sdk.on('kyt.passed',  ({ transaction, score }) =>
  console.log(`KYT passed: score ${score} for ${transaction.sender} on ${transaction.chain}`));
sdk.on('kyt.blocked', ({ transaction, score }) =>
  console.warn(`KYT blocked: score ${score} for ${transaction.sender} on ${transaction.chain}`));
sdk.on('error',       ({ error, context })     =>
  console.error(`Error [${context}]:`, error.message));

await sdk.initialize();

const wallet = await sdk.createTrackingWallet({
  chains:             ['ethereum', 'arbitrum'],
  destinationAddress: process.env['DESTINATION_ADDRESS'] ?? '',
  label:              'kms-demo',
});

console.log('Tracking wallet:', wallet.evmAddress);

process.on('SIGINT', async () => { await sdk.shutdown(); process.exit(0); });
await new Promise(() => {});
