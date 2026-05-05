import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { WebhookDelivery } from '../../src/events/webhook.js';

const WEBHOOK_URL = 'https://example.com/webhook';
const SECRET      = 'test-hmac-secret';

function mockFetch(status: number, body = ''): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok:   status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  });
}

describe('WebhookDelivery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs JSON to the configured URL', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery(WEBHOOK_URL, null);
    await delivery.deliver('kyt.passed', {
      transaction: {} as never,
      score: 10,
      report: {} as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      WEBHOOK_URL,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('includes X-KYT-Signature header when secret is provided', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery(WEBHOOK_URL, () => Promise.resolve(SECRET));
    await delivery.deliver('kyt.blocked', {
      transaction: {} as never,
      score: 90,
      report: {} as never,
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers     = options.headers as Record<string, string>;
    expect(headers['X-KYT-Signature']).toBeTruthy();
    expect(typeof headers['X-KYT-Signature']).toBe('string');
  });

  it('does NOT include X-KYT-Signature header when no secret', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery(WEBHOOK_URL, null);
    await delivery.deliver('gas.low', {
      walletId: 'w1',
      chain: 'ethereum',
      currentBalance: 0n,
      required: 1000n,
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers     = options.headers as Record<string, string>;
    expect(headers['X-KYT-Signature']).toBeUndefined();
  });

  it('retries on failure and eventually throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const delivery = new WebhookDelivery(WEBHOOK_URL, null);

    let caught: Error | null = null;
    const promise = delivery
      .deliver('error', { error: new Error('x'), context: 'test' })
      .catch((e: Error) => { caught = e; });

    // Advance through all retry delays (1s + 2s + 4s)
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch('failed after');
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    vi.useRealTimers();
  });

  it('serializes BigInt values to strings in payload', async () => {
    let capturedBody = '';
    const fetchMock  = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    });
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery(WEBHOOK_URL, null);
    await delivery.deliver('transfer.completed', {
      walletId: 'w1',
      chain:    'ethereum',
      txHash:   '0xabc',
      token:    'USDT',
      amount:   123_456_789n,
    });

    const parsed = JSON.parse(capturedBody) as { data: { amount: string } };
    expect(parsed.data.amount).toBe('123456789');
  });
});
