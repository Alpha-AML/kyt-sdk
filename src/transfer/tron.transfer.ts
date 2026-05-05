import type { TronWeb } from 'tronweb';

export class TronTransferService {
  constructor(
    private readonly rpcUrl: string,
    private readonly tronGridApiKey?: string,
  ) {}

  /**
   * Transfer a TRC-20 token.
   * @param amount Raw amount in token's smallest unit.  Pass undefined to transfer full balance.
   */
  async transferToken(
    privateKey:      string,
    contractAddress: string,
    toAddress:       string,
    amount?:         bigint,
  ): Promise<string> {
    const tw      = await this.buildTronWeb(privateKey);
    const owner   = tw.defaultAddress.base58;
    const balance = amount ?? (await this.getTokenBalance(tw, contractAddress, owner));

    if (balance === 0n) throw new Error('Transfer amount is zero');

    const contract = await tw.contract(TRC20_ABI, contractAddress);
    const txid     = await contract.transfer(toAddress, balance.toString()).send({ feeLimit: 100_000_000 });
    return txid;
  }

  /**
   * Transfer native TRX.
   * @param amount Amount in SUN (1 TRX = 1 000 000 sun).  Pass undefined to sweep full balance minus fee reserve.
   */
  async transferNative(
    privateKey: string,
    toAddress:  string,
    amount?:    bigint,
  ): Promise<string> {
    const tw   = await this.buildTronWeb(privateKey);
    const from = tw.defaultAddress.base58;

    let sun: bigint;
    if (amount !== undefined) {
      sun = amount;
    } else {
      const balance    = await this.getTrxBalance(tw, from);
      const feeReserve = 5_000_000n; // 5 TRX
      if (balance <= feeReserve) throw new Error('Insufficient TRX balance');
      sun = balance - feeReserve;
    }

    if (sun === 0n) throw new Error('Transfer amount is zero');

    if (sun > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Native transfer amount ${sun} sun exceeds safe integer range`);
    }
    const txObj  = await tw.transactionBuilder.sendTrx(toAddress, Number(sun), from);
    const signed = await tw.trx.sign(txObj as unknown as object, privateKey);
    const result = await tw.trx.sendRawTransaction(signed as unknown as object);
    return result.txid ?? '';
  }

  async getTokenBalanceByKey(
    privateKey:      string,
    contractAddress: string,
    ownerAddress:    string,
  ): Promise<bigint> {
    const tw = await this.buildTronWeb(privateKey);
    return this.getTokenBalance(tw, contractAddress, ownerAddress);
  }

  async getTrxBalanceByAddress(address: string): Promise<bigint> {
    const url  = `${this.rpcUrl.replace(/\/$/, '')}/v1/accounts/${address}`;
    const resp = await fetch(url, { headers: this.apiKeyHeaders() });
    if (!resp.ok) return 0n;
    const json = await resp.json() as { data?: Array<{ balance?: number }> };
    return BigInt(json.data?.[0]?.balance ?? 0);
  }

  private async getTokenBalance(tw: TronWeb, contractAddress: string, owner: string): Promise<bigint> {
    const contract = await tw.contract(TRC20_ABI, contractAddress);
    const result   = await contract.balanceOf(owner).call();
    return BigInt(String(result));
  }

  private async getTrxBalance(tw: TronWeb, address: string): Promise<bigint> {
    const balance = await tw.trx.getBalance(address);
    return BigInt(balance);
  }

  private async buildTronWeb(privateKey: string): Promise<TronWeb> {
    const { TronWeb } = await import('tronweb');
    const tw          = new TronWeb({ fullHost: this.rpcUrl, headers: this.apiKeyHeaders() });
    tw.setPrivateKey(privateKey);
    return tw;
  }

  private apiKeyHeaders(): Record<string, string> {
    return this.tronGridApiKey ? { 'TRON-PRO-API-KEY': this.tronGridApiKey } : {};
  }
}

const TRC20_ABI = [
  {
    inputs:  [{ name: 'account', type: 'address' }],
    name:    'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    type:    'function',
    stateMutability: 'view',
  },
  {
    inputs:  [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }],
    name:    'transfer',
    outputs: [{ name: '', type: 'bool' }],
    type:    'function',
    stateMutability: 'nonpayable',
  },
];
