import { EventEmitter } from 'events';
import type { SdkEvents } from '../types.js';

type Handler<T> = (data: T) => void | Promise<void>;

/**
 * Typed event bus wrapping Node.js EventEmitter.
 * All event names are defined in SdkEvents to prevent typos.
 */
export class SdkEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof SdkEvents>(event: K, handler: Handler<SdkEvents[K]>): void {
    this.emitter.on(event, handler);
  }

  off<K extends keyof SdkEvents>(event: K, handler: Handler<SdkEvents[K]>): void {
    this.emitter.off(event, handler);
  }

  once<K extends keyof SdkEvents>(event: K, handler: Handler<SdkEvents[K]>): void {
    this.emitter.once(event, handler);
  }

  emit<K extends keyof SdkEvents>(event: K, data: SdkEvents[K]): void {
    this.emitter.emit(event, data);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
