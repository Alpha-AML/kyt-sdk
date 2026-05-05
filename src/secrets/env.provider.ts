import type { SecretsProvider } from '../types.js';

export interface EnvSecretsConfig {
  /** process.env key for the master seed.  Default: KYT_MASTER_SEED */
  masterSeedKey?: string;
  /** process.env key for the gas reserve private key.  Default: KYT_GAS_RESERVE_KEY */
  gasReserveKeyKey?: string;
  /** process.env key for the Alpha AML API key.  Default: KYT_ALPHA_AML_API_KEY */
  alphaAmlApiKeyKey?: string;
  /** process.env key for the webhook HMAC secret.  Default: KYT_WEBHOOK_SECRET */
  webhookSecretKey?: string;
}

/**
 * Reads secrets from environment variables / .env file.
 *
 * Suitable for local development.  For production deployments use
 * AwsKmsSecretsProvider or VaultSecretsProvider instead.
 */
export class EnvSecretsProvider implements SecretsProvider {
  private readonly cfg: Required<EnvSecretsConfig>;

  constructor(config: EnvSecretsConfig = {}) {
    this.cfg = {
      masterSeedKey:     config.masterSeedKey     ?? 'KYT_MASTER_SEED',
      gasReserveKeyKey:  config.gasReserveKeyKey  ?? 'KYT_GAS_RESERVE_KEY',
      alphaAmlApiKeyKey: config.alphaAmlApiKeyKey ?? 'KYT_ALPHA_AML_API_KEY',
      webhookSecretKey:  config.webhookSecretKey  ?? 'KYT_WEBHOOK_SECRET',
    };
  }

  async getMasterSeed(): Promise<string> {
    return this.require(this.cfg.masterSeedKey);
  }

  async getGasReservePrivateKey(): Promise<string> {
    return this.require(this.cfg.gasReserveKeyKey);
  }

  async getAlphaAmlApiKey(): Promise<string> {
    return this.require(this.cfg.alphaAmlApiKeyKey);
  }

  async getWebhookSecret(): Promise<string> {
    return this.require(this.cfg.webhookSecretKey);
  }

  private require(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`EnvSecretsProvider: environment variable "${key}" is not set`);
    return val;
  }
}
