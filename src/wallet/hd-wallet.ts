import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { randomBytes } from 'crypto';

// BIP44 coin types
const COIN_ETH  = 60;
const COIN_TRON = 195;

export interface DerivedEvmWallet {
  address: string;    // checksum-encoded 0x address
  privateKey: string; // 0x-prefixed hex
  index: number;
}

export interface DerivedTronWallet {
  address: string;    // Base58Check T… address
  privateKey: string; // hex, no prefix
  index: number;
}

/**
 * HD wallet manager.  Derives EVM and Tron wallets from a single master seed
 * via BIP32/BIP44 so clients store one secret and recover any wallet by index.
 *
 * EVM  derivation path: m/44'/60'/0'/0/{index}
 * Tron derivation path: m/44'/195'/0'/0/{index}
 */
export class HdWalletManager {
  private readonly masterKey: HDKey;

  /**
   * @param seedHex 64 hex chars (32 bytes) — the raw BIP32 seed.
   *                Generate with HdWalletManager.generateSeed() or
   *                convert a BIP39 mnemonic via HdWalletManager.mnemonicToSeed().
   */
  constructor(seedHex: string) {
    if (!/^[0-9a-fA-F]{64,128}$/.test(seedHex)) {
      throw new Error('Master seed must be a hex string of at least 64 characters (32 bytes)');
    }
    this.masterKey = HDKey.fromMasterSeed(Buffer.from(seedHex, 'hex'));
  }

  deriveEvm(index: number): DerivedEvmWallet {
    this.validateIndex(index);
    const child = this.masterKey.derive(`m/44'/${COIN_ETH}'/0'/0/${index}`);
    if (!child.privateKey) throw new Error(`Failed to derive EVM key at index ${index}`);

    const privKeyHex = Buffer.from(child.privateKey).toString('hex');
    const address    = privateKeyToEvmAddress(child.privateKey);

    return { address, privateKey: `0x${privKeyHex}`, index };
  }

  deriveTron(index: number): DerivedTronWallet {
    this.validateIndex(index);
    const child = this.masterKey.derive(`m/44'/${COIN_TRON}'/0'/0/${index}`);
    if (!child.privateKey) throw new Error(`Failed to derive Tron key at index ${index}`);

    const privKeyHex = Buffer.from(child.privateKey).toString('hex');
    const address    = privateKeyToTronAddress(child.privateKey);

    return { address, privateKey: privKeyHex, index };
  }

  private validateIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 2_147_483_647) {
      throw new Error(`Derivation index must be a non-negative integer ≤ 2^31-1, got ${index}`);
    }
  }

  /** Generate a cryptographically random 32-byte hex seed. */
  static generateSeed(): string {
    return randomBytes(32).toString('hex');
  }

  /** Generate a BIP39 mnemonic (24 words). */
  static generateMnemonic(): string {
    return generateMnemonic(wordlist, 256);
  }

  /** Validate a BIP39 mnemonic and return its 64-byte hex seed. */
  static mnemonicToSeed(mnemonic: string, passphrase?: string): string {
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error('Invalid BIP39 mnemonic');
    }
    return Buffer.from(mnemonicToSeedSync(mnemonic, passphrase)).toString('hex');
  }
}

// ----------------------------------------------------------
// Internal address derivation helpers
// ----------------------------------------------------------

function privateKeyToEvmAddress(privKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privKey, false); // uncompressed 65 bytes
  const hash   = keccak_256(pubKey.slice(1));             // keccak of 64-byte payload
  const addr   = '0x' + Buffer.from(hash.slice(-20)).toString('hex');
  return toChecksumAddress(addr);
}

function privateKeyToTronAddress(privKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privKey, false); // uncompressed 65 bytes
  const hash   = keccak_256(pubKey.slice(1));
  // Tron: network prefix 0x41 + last 20 bytes of keccak256(pubKey)
  const raw    = new Uint8Array(21);
  raw[0] = 0x41;
  raw.set(hash.slice(-20), 1);
  return base58check(raw);
}

function base58check(payload: Uint8Array): string {
  const h1       = sha256(payload);
  const h2       = sha256(h1);
  const checksum = h2.slice(0, 4);
  const full     = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58.encode(full);
}

function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace('0x', '');
  const hash = Buffer.from(keccak_256(Buffer.from(addr, 'utf8'))).toString('hex');
  let result = '0x';
  for (let i = 0; i < addr.length; i++) {
    const char = addr[i]!;
    result += parseInt(hash[i]!, 16) >= 8 ? char.toUpperCase() : char;
  }
  return result;
}
