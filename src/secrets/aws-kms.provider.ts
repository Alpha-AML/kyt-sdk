import {
  KMSClient,
  DecryptCommand,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import type { SecretsProvider } from '../types.js';

export interface AwsKmsSecretsConfig {
  /**
   * ARN or key ID of the KMS key used to decrypt ciphertexts.
   * The ciphertexts themselves are stored in environment variables (see below).
   */
  keyId: string;

  /**
   * AWS SDK client configuration (region, credentials, endpoint, etc.).
   * When omitted, the AWS SDK resolves credentials from the environment,
   * instance metadata, or ~/.aws/credentials as normal.
   */
  kmsConfig?: KMSClientConfig;

  /**
   * Base64-encoded KMS ciphertext blobs for each secret.
   * Encrypt with:
   *   aws kms encrypt --key-id <key-id> --plaintext fileb://<(echo -n "your_secret") \
   *     --query CiphertextBlob --output text
   */
  encryptedMasterSeed:        string;
  encryptedGasReserveKey:     string;
  encryptedAlphaAmlApiKey:    string;
  encryptedWebhookSecret?:    string;
}

/**
 * Resolves secrets by decrypting KMS-encrypted ciphertexts at runtime.
 *
 * The plaintext secrets never touch disk in cleartext — only the encrypted
 * blobs are stored (e.g. in environment variables or config files).
 */
export class AwsKmsSecretsProvider implements SecretsProvider {
  private readonly kms: KMSClient;
  private readonly cfg: AwsKmsSecretsConfig;
  private readonly cache = new Map<string, string>();

  constructor(config: AwsKmsSecretsConfig) {
    this.cfg = config;
    this.kms = new KMSClient(config.kmsConfig ?? {});
  }

  async getMasterSeed(): Promise<string> {
    return this.decrypt('masterSeed', this.cfg.encryptedMasterSeed);
  }

  async getGasReservePrivateKey(): Promise<string> {
    return this.decrypt('gasReserveKey', this.cfg.encryptedGasReserveKey);
  }

  async getAlphaAmlApiKey(): Promise<string> {
    return this.decrypt('alphaAmlApiKey', this.cfg.encryptedAlphaAmlApiKey);
  }

  async getWebhookSecret(): Promise<string> {
    if (!this.cfg.encryptedWebhookSecret) {
      throw new Error('AwsKmsSecretsProvider: encryptedWebhookSecret is not configured');
    }
    return this.decrypt('webhookSecret', this.cfg.encryptedWebhookSecret);
  }

  private async decrypt(cacheKey: string, ciphertextB64: string): Promise<string> {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const ciphertextBlob = Buffer.from(ciphertextB64, 'base64');
    const response = await this.kms.send(
      new DecryptCommand({
        KeyId: this.cfg.keyId,
        CiphertextBlob: ciphertextBlob,
      }),
    );

    if (!response.Plaintext) {
      throw new Error(`AwsKmsSecretsProvider: KMS returned no plaintext for "${cacheKey}"`);
    }

    const plaintext = Buffer.from(response.Plaintext).toString('utf8');
    this.cache.set(cacheKey, plaintext);
    return plaintext;
  }
}
