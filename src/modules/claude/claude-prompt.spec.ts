import { parseClaudeResponse, buildUserPrompt } from './claude-prompt';
import type { MarketSnapshot } from './claude.types';

describe('claude-prompt', () => {
  const mockSnapshot: MarketSnapshot = {
    pair: 'BTC/USDT',
    currentPrice: 70000,
    priceChange24h: -1.5,
    volume24h: 5000000,
    regime: 'flat',
    regimeConfidence: 0.85,
    gridActive: true,
    gridBounds: { lower: 68000, upper: 72000 },
    gridStepPct: 1.25,
    balance: { usdt: 5000, btc: 0.05 },
    recentTrades: [
      { side: 'buy', price: 69500, pnl: null, time: '2026-03-21T10:00:00Z' },
      { side: 'sell', price: 70500, pnl: 8.5, time: '2026-03-21T11:00:00Z' },
    ],
    totalPnl24h: 8.5,
    dailyDrawdownPct: 1.2,
    weeklyDrawdownPct: 2.5,
    riskLevel: 'normal',
    indicators: { rsi14: 52, adx14: 18, atrPct: 2.1, macdHistogram: -15 },
  };

  describe('buildUserPrompt', () => {
    it('includes all snapshot data in prompt', () => {
      const prompt = buildUserPrompt(mockSnapshot);
      expect(prompt).toContain('BTC/USDT');
      expect(prompt).toContain('70000');
      expect(prompt).toContain('flat');
      expect(prompt).toContain('grid_recommendation');
    });
  });

  describe('parseClaudeResponse', () => {
    const validResponse = JSON.stringify({
      market_assessment: 'Market is ranging in a tight band',
      grid_recommendation: {
        action: 'keep',
        lower_bound: null,
        upper_bound: null,
        grid_step_pct: null,
        reason: 'Grid is performing well in sideways market',
      },
      risk_flags: [],
      confidence: 0.85,
      next_review_hours: 4,
    });

    it('parses valid JSON response', () => {
      const { parsed, error } = parseClaudeResponse(validResponse);
      expect(error).toBeNull();
      expect(parsed).not.toBeNull();
      expect(parsed!.grid_recommendation.action).toBe('keep');
      expect(parsed!.confidence).toBe(0.85);
    });

    it('strips markdown code fences', () => {
      const wrapped = '```json\n' + validResponse + '\n```';
      const { parsed, error } = parseClaudeResponse(wrapped);
      expect(error).toBeNull();
      expect(parsed!.grid_recommendation.action).toBe('keep');
    });

    it('rejects invalid JSON', () => {
      const { parsed, error } = parseClaudeResponse('not json at all');
      expect(parsed).toBeNull();
      expect(error).toContain('JSON parse failed');
    });

    it('rejects missing required fields', () => {
      const incomplete = JSON.stringify({ market_assessment: 'test' });
      const { parsed, error } = parseClaudeResponse(incomplete);
      expect(parsed).toBeNull();
      expect(error).toContain('Missing required fields');
    });

    it('rejects invalid action', () => {
      const bad = JSON.stringify({
        market_assessment: 'test',
        grid_recommendation: { action: 'yolo', reason: 'x' },
        risk_flags: [],
        confidence: 0.5,
        next_review_hours: 4,
      });
      const { parsed, error } = parseClaudeResponse(bad);
      expect(parsed).toBeNull();
      expect(error).toContain('Invalid action');
    });

    it('rejects out-of-range confidence', () => {
      const bad = JSON.stringify({
        market_assessment: 'test',
        grid_recommendation: { action: 'keep', reason: 'x' },
        risk_flags: [],
        confidence: 1.5,
        next_review_hours: 4,
      });
      const { parsed, error } = parseClaudeResponse(bad);
      expect(parsed).toBeNull();
      expect(error).toContain('Invalid confidence');
    });

    it('accepts all valid actions', () => {
      for (const action of ['keep', 'adjust', 'pause', 'restart']) {
        const resp = JSON.stringify({
          market_assessment: 'test',
          grid_recommendation: { action, reason: 'x' },
          risk_flags: [],
          confidence: 0.5,
          next_review_hours: 4,
        });
        const { parsed, error } = parseClaudeResponse(resp);
        expect(error).toBeNull();
        expect(parsed!.grid_recommendation.action).toBe(action);
      }
    });
  });
});
