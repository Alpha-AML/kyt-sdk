// Main SDK class
export { KytSDK } from './sdk.js';

// Types
export type {
  KytSdkConfig,
  ChainRpcConfig,
  GasConfig,
  SecretsProvider,
  SupportedChain,
  EvmChain,
  TronChain,
  TokenConfig,
  TrackingWallet,
  CreateTrackingWalletOptions,
  DetectedTransaction,
  TransactionStatus,
  AlphaAmlReport,
  ManualTransferOptions,
  ManualTransferResult,
  SdkEvents,
} from './types.js';

// Secrets providers
export { EnvSecretsProvider }    from './secrets/env.provider.js';
export { AwsKmsSecretsProvider } from './secrets/aws-kms.provider.js';
export { VaultSecretsProvider }  from './secrets/vault.provider.js';
export type { EnvSecretsConfig }     from './secrets/env.provider.js';
export type { AwsKmsSecretsConfig }  from './secrets/aws-kms.provider.js';
export type { VaultSecretsConfig }   from './secrets/vault.provider.js';

// Wallet utilities
export { HdWalletManager } from './wallet/hd-wallet.js';

// Webhook verification helper (for use in client webhook receivers)
export { verifyWebhookSignature } from './events/webhook.js';

// Chain/token config (for reference and customisation)
export { CHAIN_META, EVM_CHAINS, isEvmChain, isTronChain } from './config/chains.js';
export { DEFAULT_TOKENS, resolveTokens, findToken }         from './config/tokens.js';
