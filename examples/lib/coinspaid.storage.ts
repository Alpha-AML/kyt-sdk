import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// ----------------------------------------------------------
// coinspaid_payments — one record per payment session
//   Tracks overall status: which wallets, which customer, treasury address.
//   Does NOT track per-token CoinsPaid addresses — that's in coinspaid_addresses.
// ----------------------------------------------------------

export type CoinsPaidPaymentStatus =
  | 'pending'               // created, waiting for user deposit on buffer wallet 1
  | 'processing'            // at least one token is going through the flow
  | 'completed'             // all tokens forwarded to treasury
  | 'error';                // at least one token failed — check coinspaid_addresses for details

export interface CoinsPaidPaymentRecord {
  id:                  string;
  foreign_id:          string;  // = source_wallet_id (base of all CoinsPaid foreign_ids)
  customer_id:         string;  // end_user_reference — sent to CoinsPaid, links to your customer
  chain:               string;
  source_wallet_id:    string;  // buffer wallet 1 (user deposit)
  receiving_wallet_id: string;  // buffer wallet 2 (CoinsPaid withdrawal)
  treasury_address:    string;
  status:              CoinsPaidPaymentStatus;
  expected_amount:     string;
  error_message:       string | null;
  created_at:          number;
}

// ----------------------------------------------------------
// coinspaid_addresses — one record per token per payment
//   User A sends USDC → one row (USDCA address, USDC amounts, withdrawal ID)
//   User A sends USDT → second row (USDTA address, USDT amounts, withdrawal ID)
// ----------------------------------------------------------

export type CoinsPaidAddressStatus =
  | 'address_created'       // CoinsPaid deposit address created
  | 'forwarded'             // funds sent from buffer wallet 1 → CoinsPaid address
  | 'confirmed'             // CoinsPaid webhook confirmed receipt
  | 'withdrawal_initiated'  // CoinsPaid withdrawal to buffer wallet 2 started
  | 'completed'             // buffer wallet 2 forwarded to treasury
  | 'error';

export interface CoinsPaidAddressRecord {
  id:                string;
  payment_id:        string;  // FK → coinspaid_payments.id
  token_symbol:      string;  // e.g. USDC, USDT
  cp_currency:       string;  // CoinsPaid currency code e.g. USDCA, USDTA
  cp_foreign_id:     string;  // e.g. "wallet1-uuid:usdc" — unique per address in CoinsPaid
  coinspaid_address: string;
  status:            CoinsPaidAddressStatus;
  sent_amount:       string | null;      // amount forwarded wallet1 → CoinsPaid (raw bigint string)
  received_amount:   string | null;      // amount CoinsPaid confirmed (human-readable, e.g. "100.00")
  withdrawal_id:     string | null;      // CoinsPaid withdrawal ID
  error_message:     string | null;
  created_at:        number;
}

// ----------------------------------------------------------

export class CoinsPaidStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coinspaid_payments (
        id                  TEXT PRIMARY KEY,
        foreign_id          TEXT UNIQUE NOT NULL,
        customer_id         TEXT NOT NULL,
        chain               TEXT NOT NULL,
        source_wallet_id    TEXT NOT NULL,
        receiving_wallet_id TEXT NOT NULL,
        treasury_address    TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        expected_amount     TEXT NOT NULL,
        error_message       TEXT,
        created_at          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coinspaid_addresses (
        id                TEXT PRIMARY KEY,
        payment_id        TEXT NOT NULL REFERENCES coinspaid_payments(id),
        token_symbol      TEXT NOT NULL,
        cp_currency       TEXT NOT NULL,
        cp_foreign_id     TEXT UNIQUE NOT NULL,
        coinspaid_address TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'address_created',
        sent_amount       TEXT,
        received_amount   TEXT,
        withdrawal_id     TEXT,
        error_message     TEXT,
        created_at        INTEGER NOT NULL
      );
    `);
  }

  // ----------------------------------------------------------
  // coinspaid_payments
  // ----------------------------------------------------------

  insertPayment(record: CoinsPaidPaymentRecord): void {
    this.db.prepare(`
      INSERT INTO coinspaid_payments
        (id, foreign_id, customer_id, chain, source_wallet_id,
         receiving_wallet_id, treasury_address, status, expected_amount,
         error_message, created_at)
      VALUES
        (@id, @foreign_id, @customer_id, @chain, @source_wallet_id,
         @receiving_wallet_id, @treasury_address, @status, @expected_amount,
         @error_message, @created_at)
    `).run(record);
  }

  findPaymentById(id: string): CoinsPaidPaymentRecord | undefined {
    return this.db
      .prepare('SELECT * FROM coinspaid_payments WHERE id = ?')
      .get(id) as CoinsPaidPaymentRecord | undefined;
  }

  findPaymentByForeignId(foreignId: string): CoinsPaidPaymentRecord | undefined {
    return this.db
      .prepare('SELECT * FROM coinspaid_payments WHERE foreign_id = ?')
      .get(foreignId) as CoinsPaidPaymentRecord | undefined;
  }

  findPaymentBySourceWalletId(walletId: string): CoinsPaidPaymentRecord | undefined {
    return this.db
      .prepare('SELECT * FROM coinspaid_payments WHERE source_wallet_id = ?')
      .get(walletId) as CoinsPaidPaymentRecord | undefined;
  }

  findPaymentByReceivingWalletId(walletId: string): CoinsPaidPaymentRecord | undefined {
    return this.db
      .prepare('SELECT * FROM coinspaid_payments WHERE receiving_wallet_id = ?')
      .get(walletId) as CoinsPaidPaymentRecord | undefined;
  }

  updateReceivingWallet(id: string, walletId: string, treasuryAddress: string): void {
    this.db.prepare(`
      UPDATE coinspaid_payments
      SET receiving_wallet_id = @walletId,
          treasury_address    = @treasuryAddress
      WHERE id = @id
    `).run({ id, walletId, treasuryAddress });
  }

  updatePaymentStatus(
    id: string,
    status: CoinsPaidPaymentStatus,
    errorMessage?: string,
  ): void {
    this.db.prepare(`
      UPDATE coinspaid_payments
      SET status        = @status,
          error_message = COALESCE(@errorMessage, error_message)
      WHERE id = @id
    `).run({ id, status, errorMessage: errorMessage ?? null });
  }

  // ----------------------------------------------------------
  // coinspaid_addresses
  // ----------------------------------------------------------

  insertAddress(record: CoinsPaidAddressRecord): void {
    this.db.prepare(`
      INSERT INTO coinspaid_addresses
        (id, payment_id, token_symbol, cp_currency, cp_foreign_id,
         coinspaid_address, status, sent_amount, received_amount,
         withdrawal_id, error_message, created_at)
      VALUES
        (@id, @payment_id, @token_symbol, @cp_currency, @cp_foreign_id,
         @coinspaid_address, @status, @sent_amount, @received_amount,
         @withdrawal_id, @error_message, @created_at)
    `).run(record);
  }

  findAddressByCpForeignId(cpForeignId: string): CoinsPaidAddressRecord | undefined {
    return this.db
      .prepare('SELECT * FROM coinspaid_addresses WHERE cp_foreign_id = ?')
      .get(cpForeignId) as CoinsPaidAddressRecord | undefined;
  }

  findAddressByDepositAddress(coinspaidAddress: string): CoinsPaidAddressRecord | undefined {
    return this.db
      .prepare('SELECT * FROM coinspaid_addresses WHERE coinspaid_address = ?')
      .get(coinspaidAddress) as CoinsPaidAddressRecord | undefined;
  }

  findAddressesByPaymentId(paymentId: string): CoinsPaidAddressRecord[] {
    return this.db
      .prepare('SELECT * FROM coinspaid_addresses WHERE payment_id = ? ORDER BY created_at ASC')
      .all(paymentId) as CoinsPaidAddressRecord[];
  }

  updateAddressStatus(
    id: string,
    status: CoinsPaidAddressStatus,
    extra: {
      sent_amount?:     string;
      received_amount?: string;
      withdrawal_id?:   string;
      error_message?:   string;
    } = {},
  ): void {
    this.db.prepare(`
      UPDATE coinspaid_addresses
      SET status          = @status,
          sent_amount     = COALESCE(@sent_amount, sent_amount),
          received_amount = COALESCE(@received_amount, received_amount),
          withdrawal_id   = COALESCE(@withdrawal_id, withdrawal_id),
          error_message   = COALESCE(@error_message, error_message)
      WHERE id = @id
    `).run({
      id,
      status,
      sent_amount:     extra.sent_amount     ?? null,
      received_amount: extra.received_amount ?? null,
      withdrawal_id:   extra.withdrawal_id   ?? null,
      error_message:   extra.error_message   ?? null,
    });
  }

  close(): void {
    this.db.close();
  }
}
