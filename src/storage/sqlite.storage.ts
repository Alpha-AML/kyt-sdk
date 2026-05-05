import Database from 'better-sqlite3';
import type {
  TrackingWallet,
  DetectedTransaction,
  TransactionStatus,
  SupportedChain,
  AlphaAmlReport,
} from '../types.js';

// ----------------------------------------------------------
// Row types (SQLite ↔ domain model mapping)
// ----------------------------------------------------------

interface WalletRow {
  id: string;
  index_num: number;
  evm_address: string | null;
  tron_address: string | null;
  chains: string;          // JSON
  destination_address: string;
  risk_threshold: number;
  polling_interval_ms: number;
  label: string | null;
  status: string;
  created_at: number;      // Unix ms
}

interface TxRow {
  id: string;
  wallet_id: string;
  chain: string;
  tx_hash: string;
  block_number: number;
  sender: string;
  token_address: string;
  token_symbol: string;
  amount: string;          // BigInt as decimal string
  decimals: number;
  status: string;
  kyt_score: number | null;
  kyt_response: string | null; // JSON
  detected_at: number;
  processed_at: number | null;
}

interface MonitorStateRow {
  wallet_id: string;
  chain: string;
  last_block: number;
}

export class SqliteStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  // ----------------------------------------------------------
  // Tracking wallets
  // ----------------------------------------------------------

  upsertWallet(w: TrackingWallet): void {
    this.db
      .prepare<unknown[]>(
        `INSERT INTO tracking_wallets
           (id, index_num, evm_address, tron_address, chains, destination_address,
            risk_threshold, polling_interval_ms, label, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           status             = excluded.status,
           destination_address= excluded.destination_address,
           risk_threshold     = excluded.risk_threshold,
           polling_interval_ms= excluded.polling_interval_ms,
           label              = excluded.label`,
      )
      .run(
        w.id,
        w.index,
        w.evmAddress ?? null,
        w.tronAddress ?? null,
        JSON.stringify(w.chains),
        w.destinationAddress,
        w.riskThreshold,
        w.pollingIntervalMs,
        w.label ?? null,
        w.status,
        w.createdAt.getTime(),
      );
  }

  getWallet(id: string): TrackingWallet | undefined {
    const row = this.db
      .prepare<[string], WalletRow>('SELECT * FROM tracking_wallets WHERE id = ?')
      .get(id);
    return row ? this.rowToWallet(row) : undefined;
  }

  listWallets(): TrackingWallet[] {
    return this.db
      .prepare<[], WalletRow>('SELECT * FROM tracking_wallets ORDER BY index_num ASC')
      .all()
      .map(r => this.rowToWallet(r));
  }

  listActiveWallets(): TrackingWallet[] {
    return this.db
      .prepare<[], WalletRow>(
        "SELECT * FROM tracking_wallets WHERE status = 'active' ORDER BY index_num ASC",
      )
      .all()
      .map(r => this.rowToWallet(r));
  }

  maxWalletIndex(): number {
    const row = this.db
      .prepare<[], { max_idx: number | null }>('SELECT MAX(index_num) AS max_idx FROM tracking_wallets')
      .get();
    return row?.max_idx ?? -1;
  }

  // ----------------------------------------------------------
  // Transactions
  // ----------------------------------------------------------

  insertTransaction(tx: DetectedTransaction): void {
    this.db
      .prepare<unknown[]>(
        `INSERT OR IGNORE INTO transactions
           (id, wallet_id, chain, tx_hash, block_number, sender, token_address,
            token_symbol, amount, decimals, status, kyt_score, kyt_response,
            detected_at, processed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        tx.id,
        tx.walletId,
        tx.chain,
        tx.txHash,
        tx.blockNumber,
        tx.sender,
        tx.tokenAddress,
        tx.tokenSymbol,
        tx.amount.toString(),
        tx.decimals,
        tx.status,
        tx.kytScore ?? null,
        tx.kytResponse ? JSON.stringify(tx.kytResponse) : null,
        tx.detectedAt.getTime(),
        tx.processedAt ? tx.processedAt.getTime() : null,
      );
  }

  updateTransactionStatus(
    id: string,
    status: TransactionStatus,
    extra?: { kytScore?: number; kytResponse?: AlphaAmlReport },
  ): void {
    const now = Date.now();
    this.db
      .prepare<unknown[]>(
        `UPDATE transactions
            SET status       = ?,
                kyt_score    = COALESCE(?, kyt_score),
                kyt_response = COALESCE(?, kyt_response),
                processed_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        extra?.kytScore ?? null,
        extra?.kytResponse ? JSON.stringify(extra.kytResponse) : null,
        now,
        id,
      );
  }

  getTransaction(id: string): DetectedTransaction | undefined {
    const row = this.db
      .prepare<[string], TxRow>('SELECT * FROM transactions WHERE id = ?')
      .get(id);
    return row ? this.rowToTx(row) : undefined;
  }

  listTransactions(walletId: string): DetectedTransaction[] {
    return this.db
      .prepare<[string], TxRow>('SELECT * FROM transactions WHERE wallet_id = ? ORDER BY detected_at ASC')
      .all(walletId)
      .map(r => this.rowToTx(r));
  }

  /** Returns transactions that are not yet in a terminal state (approved/blocked/forwarded). */
  listPendingTransactions(walletId: string): DetectedTransaction[] {
    return this.db
      .prepare<[string], TxRow>(
        `SELECT * FROM transactions
          WHERE wallet_id = ?
            AND status NOT IN ('forwarded', 'blocked')
          ORDER BY detected_at ASC`,
      )
      .all(walletId)
      .map(r => this.rowToTx(r));
  }

  /**
   * Returns transactions eligible for forwarding:
   * approved but not yet forwarded.
   */
  listApprovedPendingForward(walletId: string): DetectedTransaction[] {
    return this.db
      .prepare<[string], TxRow>(
        `SELECT * FROM transactions
          WHERE wallet_id = ? AND status = 'approved'
          ORDER BY detected_at ASC`,
      )
      .all(walletId)
      .map(r => this.rowToTx(r));
  }

  /** True when all transactions for this wallet are in a terminal state. */
  allTransactionsResolved(walletId: string): boolean {
    const row = this.db
      .prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM transactions
          WHERE wallet_id = ?
            AND status IN ('pending_confirmations', 'pending_kyt')`,
      )
      .get(walletId);
    return (row?.cnt ?? 0) === 0;
  }

  markTransactionsForwarded(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare<unknown[]>(`UPDATE transactions SET status = 'forwarded', processed_at = ? WHERE id IN (${placeholders})`)
      .run(Date.now(), ...ids);
  }

  // ----------------------------------------------------------
  // Monitor state (last processed block per wallet+chain)
  // ----------------------------------------------------------

  getLastBlock(walletId: string, chain: SupportedChain): number {
    const row = this.db
      .prepare<[string, string], MonitorStateRow>(
        'SELECT * FROM monitor_state WHERE wallet_id = ? AND chain = ?',
      )
      .get(walletId, chain);
    return row?.last_block ?? 0;
  }

  setLastBlock(walletId: string, chain: SupportedChain, block: number): void {
    this.db
      .prepare<unknown[]>(
        `INSERT INTO monitor_state (wallet_id, chain, last_block) VALUES (?,?,?)
         ON CONFLICT(wallet_id, chain) DO UPDATE SET last_block = excluded.last_block`,
      )
      .run(walletId, chain, block);
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  close(): void {
    this.db.close();
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private rowToWallet(r: WalletRow): TrackingWallet {
    return {
      id:                 r.id,
      index:              r.index_num,
      evmAddress:         r.evm_address ?? undefined,
      tronAddress:        r.tron_address ?? undefined,
      chains:             JSON.parse(r.chains) as SupportedChain[],
      destinationAddress: r.destination_address,
      riskThreshold:      r.risk_threshold,
      pollingIntervalMs:  r.polling_interval_ms,
      label:              r.label ?? undefined,
      status:             r.status as TrackingWallet['status'],
      createdAt:          new Date(r.created_at),
    };
  }

  private rowToTx(r: TxRow): DetectedTransaction {
    return {
      id:           r.id,
      walletId:     r.wallet_id,
      chain:        r.chain as SupportedChain,
      txHash:       r.tx_hash,
      blockNumber:  r.block_number,
      sender:       r.sender,
      tokenAddress: r.token_address,
      tokenSymbol:  r.token_symbol,
      amount:       BigInt(r.amount),
      decimals:     r.decimals,
      status:       r.status as TransactionStatus,
      kytScore:     r.kyt_score ?? undefined,
      kytResponse:  r.kyt_response ? (JSON.parse(r.kyt_response) as AlphaAmlReport) : undefined,
      detectedAt:   new Date(r.detected_at),
      processedAt:  r.processed_at ? new Date(r.processed_at) : undefined,
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracking_wallets (
        id                  TEXT PRIMARY KEY,
        index_num           INTEGER NOT NULL UNIQUE,
        evm_address         TEXT,
        tron_address        TEXT,
        chains              TEXT NOT NULL,
        destination_address TEXT NOT NULL,
        risk_threshold      INTEGER NOT NULL DEFAULT 50,
        polling_interval_ms INTEGER NOT NULL DEFAULT 60000,
        label               TEXT,
        status              TEXT NOT NULL DEFAULT 'active',
        created_at          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id           TEXT PRIMARY KEY,
        wallet_id    TEXT NOT NULL,
        chain        TEXT NOT NULL,
        tx_hash      TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        sender       TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol  TEXT NOT NULL,
        amount        TEXT NOT NULL,
        decimals      INTEGER NOT NULL,
        status        TEXT NOT NULL,
        kyt_score     INTEGER,
        kyt_response  TEXT,
        detected_at   INTEGER NOT NULL,
        processed_at  INTEGER,
        FOREIGN KEY (wallet_id) REFERENCES tracking_wallets(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tx_wallet_status
        ON transactions (wallet_id, status);

      CREATE TABLE IF NOT EXISTS monitor_state (
        wallet_id  TEXT NOT NULL,
        chain      TEXT NOT NULL,
        last_block INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (wallet_id, chain),
        FOREIGN KEY (wallet_id) REFERENCES tracking_wallets(id)
      );
    `);
  }
}
