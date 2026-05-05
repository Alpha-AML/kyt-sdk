import { createHmac } from 'crypto';
import type { SdkEvents } from '../types.js';

const MAX_RETRIES  = 3;
const RETRY_DELAYS = [1_000, 2_000, 4_000]; // ms

export interface WebhookPayload<K extends keyof SdkEvents = keyof SdkEvents> {
  event:     K;
  timestamp: string; // ISO 8601
  data:      SdkEvents[K];
}

/**
 * Delivers SDK events to a client-configured HTTP endpoint.
 *
 * Each payload is signed with HMAC-SHA256 using the configured secret;
 * the signature is sent in the X-KYT-Signature header so the receiver
 * can verify authenticity.
 *
 * Delivery is attempted up to 3 times with exponential back-off.
 */
export class WebhookDelivery {
  constructor(
    private readonly webhookUrl: string,
    private readonly getSecret: (() => Promise<string>) | null,
  ) {}

  async deliver<K extends keyof SdkEvents>(event: K, data: SdkEvents[K]): Promise<void> {
    const payload: WebhookPayload<K> = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const body      = JSON.stringify(payload, bigIntReplacer);
    const signature = await this.sign(body);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-KYT-SDK-Version': '1.0.0',
        };
        if (signature) headers['X-KYT-Signature'] = signature;

        const response = await fetch(this.webhookUrl, { method: 'POST', headers, body });

        if (response.ok) return;

        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `Webhook delivery failed after ${MAX_RETRIES + 1} attempts for event "${event}": ${String(err)}`,
          );
        }
        await sleep(RETRY_DELAYS[attempt] ?? 4_000);
      }
    }
  }

  private async sign(body: string): Promise<string | null> {
    if (!this.getSecret) return null;
    try {
      const secret = await this.getSecret();
      return createHmac('sha256', secret).update(body).digest('hex');
    } catch {
      return null;
    }
  }
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verifies the X-KYT-Signature header on an incoming webhook request.
 *
 * Usage in your webhook handler:
 *   const rawBody = await request.text();
 *   const sig     = request.headers.get('X-KYT-Signature');
 *   if (!verifyWebhookSignature(rawBody, sig, process.env.KYT_WEBHOOK_SECRET)) {
 *     return new Response('Unauthorized', { status: 401 });
 *   }
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
