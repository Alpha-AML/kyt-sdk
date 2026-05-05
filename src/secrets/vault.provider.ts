import type { SecretsProvider } from '../types.js';

export interface VaultSecretsConfig {
  /**
   * Vault server address.  Reads VAULT_ADDR env var if omitted.
   */
  addr?: string;

  /**
   * Vault token.  Reads VAULT_TOKEN env var if omitted.
   * For production prefer AppRole, Kubernetes, or AWS IAM auth instead.
   */
  token?: string;

  /**
   * KV v2 secret path (without the /data/ infix — the provider adds it).
   * Example: "secret/kyt-sdk" → reads from "secret/data/kyt-sdk".
   */
  path: string;

  /**
   * Vault namespace (Vault Enterprise / HCP Vault only).
   * Reads VAULT_NAMESPACE env var if omitted.
   */
  namespace?: string;

  /**
   * Field names within the secret object.  Defaults match the .env.example names.
   */
  fields?: {
    masterSeed?:      string;
    gasReserveKey?:   string;
    alphaAmlApiKey?:  string;
    webhookSecret?:   string;
  };
}

interface VaultKvResponse {
  data: {
    data: Record<string, string>;
  };
}

/**
 * Resolves secrets from HashiCorp Vault KV v2.
 *
 * The secret object at `path` must contain the required fields.
 * The provider fetches and caches the secret on first access.
 */
export class VaultSecretsProvider implements SecretsProvider {
  private readonly cfg: VaultSecretsConfig;
  private readonly fields: Required<NonNullable<VaultSecretsConfig['fields']>>;
  private secretCache: Record<string, string> | null = null;

  constructor(config: VaultSecretsConfig) {
    this.cfg = config;
    this.fields = {
      masterSeed:     config.fields?.masterSeed     ?? 'KYT_MASTER_SEED',
      gasReserveKey:  config.fields?.gasReserveKey  ?? 'KYT_GAS_RESERVE_KEY',
      alphaAmlApiKey: config.fields?.alphaAmlApiKey ?? 'KYT_ALPHA_AML_API_KEY',
      webhookSecret:  config.fields?.webhookSecret  ?? 'KYT_WEBHOOK_SECRET',
    };
  }

  async getMasterSeed(): Promise<string> {
    return this.getField(this.fields.masterSeed);
  }

  async getGasReservePrivateKey(): Promise<string> {
    return this.getField(this.fields.gasReserveKey);
  }

  async getAlphaAmlApiKey(): Promise<string> {
    return this.getField(this.fields.alphaAmlApiKey);
  }

  async getWebhookSecret(): Promise<string> {
    return this.getField(this.fields.webhookSecret);
  }

  private async getField(field: string): Promise<string> {
    const data = await this.fetchSecret();
    const value = data[field];
    if (!value) {
      throw new Error(`VaultSecretsProvider: field "${field}" not found at path "${this.cfg.path}"`);
    }
    return value;
  }

  private async fetchSecret(): Promise<Record<string, string>> {
    if (this.secretCache) return this.secretCache;

    const addr      = this.cfg.addr      ?? process.env['VAULT_ADDR'];
    const token     = this.cfg.token     ?? process.env['VAULT_TOKEN'];
    const namespace = this.cfg.namespace ?? process.env['VAULT_NAMESPACE'];

    if (!addr)  throw new Error('VaultSecretsProvider: Vault address is not configured (set addr or VAULT_ADDR)');
    if (!token) throw new Error('VaultSecretsProvider: Vault token is not configured (set token or VAULT_TOKEN)');

    // Build KV v2 path: "secret/kyt-sdk" → "secret/data/kyt-sdk"
    const parts = this.cfg.path.split('/');
    const mount = parts[0]!;
    const rest  = parts.slice(1).join('/');
    const url   = `${addr.replace(/\/$/, '')}/v1/${mount}/data/${rest}`;

    const headers: Record<string, string> = {
      'X-Vault-Token': token,
      'Content-Type': 'application/json',
    };
    if (namespace) headers['X-Vault-Namespace'] = namespace;

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `VaultSecretsProvider: HTTP ${response.status} fetching secret at "${this.cfg.path}": ${body}`,
      );
    }

    const json = (await response.json()) as VaultKvResponse;
    this.secretCache = json.data.data;
    return this.secretCache;
  }

  /** Clears the in-memory cache, forcing a re-fetch on next access. */
  clearCache(): void {
    this.secretCache = null;
  }
}
