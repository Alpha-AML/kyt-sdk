declare module 'tronweb' {
  interface TronWebOptions {
    fullHost:  string;
    headers?:  Record<string, string>;
  }

  interface TrxModule {
    getBalance(address: string): Promise<number>;
    sign(transaction: object, privateKey: string): Promise<object>;
    sendRawTransaction(signedTransaction: object): Promise<{ txid?: string; result?: boolean }>;
  }

  interface TransactionBuilderModule {
    sendTrx(to: string, amount: number, from: string): Promise<object>;
  }

  interface AddressModule {
    fromPrivateKey(privateKey: string): string | false;
  }

  interface ContractMethod {
    call(): Promise<unknown>;
    send(options?: object): Promise<string>;
  }

  interface TronContract {
    balanceOf(address: string): ContractMethod;
    transfer(to: string, amount: number | string): { send(options?: object): Promise<string> };
  }

  class TronWeb {
    constructor(options: TronWebOptions);
    setPrivateKey(key: string): void;
    readonly trx:                TrxModule;
    readonly transactionBuilder: TransactionBuilderModule;
    readonly address:            AddressModule;
    readonly defaultAddress:     { base58: string; hex: string };
    contract(abi: object[], address: string): Promise<TronContract>;
  }
}
