/**
 * Payment webhook client — posts JSON notifications to PAYMENT_WEBHOOK_URL.
 * Non-blocking: a failed POST logs a warning but never stops the payment flow.
 */

export async function postWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = process.env['PAYMENT_WEBHOOK_URL'] ?? '';
  if (!url) return;

  const body    = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  const headers = { 'Content-Type': 'application/json' };
  const delays  = [1000, 2000, 4000]; // backoff for 429

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (res.status === 429 && attempt < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      if (!res.ok) console.warn(`[WEBHOOK OUT] POST failed — HTTP ${res.status}`);
      return;
    } catch (err) {
      if (attempt === delays.length) {
        console.warn(`[WEBHOOK OUT] POST failed — ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
