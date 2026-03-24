import type { MarketSnapshot, ClaudeAdviceResponse } from './claude.types.js';

export const SYSTEM_PROMPT = `Ты советник автоматического grid торгового бота на крипто бирже.
Анализируй предоставленные данные и давай рекомендации.
Отвечай ТОЛЬКО валидным JSON без markdown и пояснений.

Правила:
- action "keep" — если рынок боковой и сетка работает нормально
- action "adjust" — если нужно сдвинуть границы или изменить шаг
- action "pause" — если рынок опасен (сильный тренд, высокая волатильность, drawdown)
- action "restart" — если рынок восстановился и можно перезапустить сетку
- confidence 0.0-1.0 отражает твою уверенность в рекомендации
- risk_flags — список конкретных рисков (пустой если всё ок)
- next_review_hours — когда следующий раз проверять (1-12 часов)`;

export function buildUserPrompt(snapshot: MarketSnapshot): string {
  return `Данные за последние 24 часа:
${JSON.stringify(snapshot, null, 2)}

Ответ строго в формате:
{
  "market_assessment": "краткая оценка рынка (1-2 предложения)",
  "grid_recommendation": {
    "action": "keep|adjust|pause|restart",
    "lower_bound": number | null,
    "upper_bound": number | null,
    "grid_step_pct": number | null,
    "reason": "причина рекомендации"
  },
  "risk_flags": ["string"],
  "confidence": 0.0-1.0,
  "next_review_hours": number
}`;
}

export function parseClaudeResponse(raw: string): {
  parsed: ClaudeAdviceResponse | null;
  error: string | null;
} {
  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(cleaned) as ClaudeAdviceResponse;

    // Validate required fields
    if (
      !parsed.market_assessment ||
      !parsed.grid_recommendation ||
      parsed.confidence === undefined
    ) {
      return { parsed: null, error: 'Missing required fields in response' };
    }

    const validActions = ['keep', 'adjust', 'pause', 'restart'];
    if (!validActions.includes(parsed.grid_recommendation.action)) {
      return {
        parsed: null,
        error: `Invalid action: ${parsed.grid_recommendation.action}`,
      };
    }

    if (parsed.confidence < 0 || parsed.confidence > 1) {
      return {
        parsed: null,
        error: `Invalid confidence: ${parsed.confidence}`,
      };
    }

    return { parsed, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { parsed: null, error: `JSON parse failed: ${msg}` };
  }
}
