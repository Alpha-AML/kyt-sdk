import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvSecretsProvider } from '../../src/secrets/env.provider.js';

describe('EnvSecretsProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads master seed from default env key', async () => {
    process.env['KYT_MASTER_SEED'] = 'a'.repeat(64);
    const provider = new EnvSecretsProvider();
    await expect(provider.getMasterSeed()).resolves.toBe('a'.repeat(64));
  });

  it('reads gas reserve key from default env key', async () => {
    process.env['KYT_GAS_RESERVE_KEY'] = 'b'.repeat(64);
    const provider = new EnvSecretsProvider();
    await expect(provider.getGasReservePrivateKey()).resolves.toBe('b'.repeat(64));
  });

  it('reads Alpha AML API key from default env key', async () => {
    process.env['KYT_ALPHA_AML_API_KEY'] = 'my-api-key';
    const provider = new EnvSecretsProvider();
    await expect(provider.getAlphaAmlApiKey()).resolves.toBe('my-api-key');
  });

  it('throws a descriptive error when env var is missing', async () => {
    delete process.env['KYT_MASTER_SEED'];
    const provider = new EnvSecretsProvider();
    await expect(provider.getMasterSeed()).rejects.toThrow('KYT_MASTER_SEED');
  });

  it('supports custom env key names', async () => {
    process.env['MY_CUSTOM_SEED'] = 'c'.repeat(64);
    const provider = new EnvSecretsProvider({ masterSeedKey: 'MY_CUSTOM_SEED' });
    await expect(provider.getMasterSeed()).resolves.toBe('c'.repeat(64));
  });

  it('reads webhook secret', async () => {
    process.env['KYT_WEBHOOK_SECRET'] = 'webhook-secret-value';
    const provider = new EnvSecretsProvider();
    await expect(provider.getWebhookSecret()).resolves.toBe('webhook-secret-value');
  });

  it('throws when webhook secret env var is missing', async () => {
    delete process.env['KYT_WEBHOOK_SECRET'];
    const provider = new EnvSecretsProvider();
    await expect(provider.getWebhookSecret()).rejects.toThrow('KYT_WEBHOOK_SECRET');
  });
});
