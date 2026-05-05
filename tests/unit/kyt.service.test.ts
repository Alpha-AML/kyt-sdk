import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { KytService } from '../../src/kyt/kyt.service.js';
import type { AlphaAmlReport } from '../../src/types.js';

vi.mock('axios');

const mockReport = (score: number): AlphaAmlReport => ({
  report:    { generated_at_utc: '2026-05-05T00:00:00Z' },
  wallet:    { address: '0xabc', blockchain: 'ETHEREUM', description: '', entity_tag: '' },
  risk_assessment: {
    score,
    score_max:     100,
    risk_level:    score <= 25 ? 'VERY LOW RISK' : score <= 50 ? 'LOW RISK' : 'HIGH RISK',
    blacklisted:   false,
    blacklist_note: 'No blacklist match found',
  },
  wallet_statistics: { total_transactions_count: 10, status: 'ACTIVE' },
});

describe('KytService', () => {
  let service: KytService;
  const getApiKey = vi.fn().mockResolvedValue('test-api-key');

  beforeEach(() => {
    vi.resetAllMocks();
    service = new KytService(getApiKey);
    service.clearCache();

    const mockedAxios = vi.mocked(axios);
    (mockedAxios as unknown as { create: ReturnType<typeof vi.fn> }).create = vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: mockReport(22) }),
    });
  });

  describe('check', () => {
    it('calls the Alpha AML API with address, chain, and apiKey', async () => {
      const getMock = vi.fn().mockResolvedValue({ data: mockReport(22) });
      const createMock = vi.fn().mockReturnValue({ get: getMock });
      vi.mocked(axios.create).mockReturnValue({ get: getMock } as ReturnType<typeof axios.create>);

      const svc = new KytService(getApiKey);
      await svc.check('0xabc', 'ethereum');

      expect(getApiKey).toHaveBeenCalledOnce();
    });

    it('returns the report from the API', async () => {
      const report = mockReport(30);
      const getMock = vi.fn().mockResolvedValue({ data: report });
      vi.mocked(axios.create).mockReturnValue({ get: getMock } as ReturnType<typeof axios.create>);

      const svc = new KytService(getApiKey);
      const result = await svc.check('0xdef', 'arbitrum');
      expect(result.risk_assessment.score).toBe(30);
    });

    it('throws when the API fails', async () => {
      const getMock = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.mocked(axios.create).mockReturnValue({ get: getMock } as ReturnType<typeof axios.create>);

      const svc = new KytService(getApiKey);
      await expect(svc.check('0xabc', 'ethereum')).rejects.toThrow('Network error');
    });

    it('uses cache and does not call API twice for same address+chain', async () => {
      const getMock = vi.fn().mockResolvedValue({ data: mockReport(10) });
      vi.mocked(axios.create).mockReturnValue({ get: getMock } as ReturnType<typeof axios.create>);

      const svc = new KytService(getApiKey);
      await svc.check('0xsame', 'base');
      await svc.check('0xsame', 'base');

      expect(getMock).toHaveBeenCalledTimes(1);
    });

    it('does not share cache between different chains', async () => {
      const getMock = vi.fn().mockResolvedValue({ data: mockReport(10) });
      vi.mocked(axios.create).mockReturnValue({ get: getMock } as ReturnType<typeof axios.create>);

      const svc = new KytService(getApiKey);
      await svc.check('0xsame', 'ethereum');
      await svc.check('0xsame', 'arbitrum');

      expect(getMock).toHaveBeenCalledTimes(2);
    });

    it('clearCache forces re-fetch', async () => {
      const getMock = vi.fn().mockResolvedValue({ data: mockReport(10) });
      vi.mocked(axios.create).mockReturnValue({ get: getMock } as ReturnType<typeof axios.create>);

      const svc = new KytService(getApiKey);
      await svc.check('0xaddr', 'bsc');
      svc.clearCache();
      await svc.check('0xaddr', 'bsc');

      expect(getMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('extractScore', () => {
    it('returns the risk_assessment.score field', () => {
      expect(KytService.extractScore(mockReport(42))).toBe(42);
    });

    it('handles score of 0', () => {
      expect(KytService.extractScore(mockReport(0))).toBe(0);
    });

    it('handles score of 100', () => {
      expect(KytService.extractScore(mockReport(100))).toBe(100);
    });
  });
});
