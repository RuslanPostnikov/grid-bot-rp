import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval, Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { Telegraf, Markup } from 'telegraf';
import { ExchangeService } from '../exchange/exchange.service.js';
import { GridService } from '../grid/grid.service.js';
import { RiskService } from '../risk/risk.service.js';
import { ClaudeService } from '../claude/claude.service.js';
import { PrismaService } from '../../prisma.service.js';
import {
  BOT_EVENTS,
  type RegimeChangePayload,
  type RiskEventPayload,
  type ClaudeAdvicePendingPayload,
} from '../../common/events.js';

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 min

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private chatId: string;
  private allowedUsers: string[];
  private lastHeartbeat = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly risk: RiskService,
    private readonly claude: ClaudeService,
    private readonly prisma: PrismaService,
  ) {
    this.chatId = this.config.get<string>('telegram.chatId') ?? '';
    this.allowedUsers = this.config.get<string[]>('telegram.allowedUsers') ?? [];
  }

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('telegram.botToken');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set, Telegram disabled');
      return;
    }

    this.bot = new Telegraf(token);
    this.bot.use((ctx, next) => {
      const username = ctx.from?.username;
      if (!username || !this.allowedUsers.includes(username)) {
        this.logger.warn(`Unauthorized access attempt from @${username ?? 'unknown'} (id: ${ctx.from?.id})`);
        return ctx.reply('⛔ Access denied');
      }
      return next();
    });
    this.registerCommands();
    this.registerCallbacks();

    this.bot.launch({ dropPendingUpdates: true }).catch((e) => {
      this.logger.error(`Telegram bot launch failed: ${e.message}`);
    });
    this.lastHeartbeat = Date.now();
    this.logger.log('Telegram bot started');
  }

  async onModuleDestroy(): Promise<void> {
    this.bot?.stop('NestJS shutdown');
  }

  // ─── Commands ──────────────────────────────────────────

  private registerCommands(): void {
    if (!this.bot) return;

    this.bot.command('start', (ctx) => {
      ctx.reply(
        '🤖 Grid Bot активен.\n\n' +
          '/status — текущее состояние\n' +
          '/pnl — статистика прибыли\n' +
          '/pause — остановить бота\n' +
          '/resume — возобновить бота\n' +
          '/advice — последний совет Claude',
      );
    });

    this.bot.command('status', async (ctx) => {
      try {
        const msg = await this.buildStatusMessage();
        ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        ctx.reply('❌ Ошибка получения статуса');
      }
    });

    this.bot.command('pnl', async (ctx) => {
      try {
        const msg = await this.buildPnlMessage();
        ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        ctx.reply('❌ Ошибка получения PnL');
      }
    });

    this.bot.command('pause', async (ctx) => {
      if (!this.grid.isActive()) {
        ctx.reply('⏸ Бот уже на паузе');
        return;
      }
      await this.grid.cancelGrid();
      ctx.reply('⏸ Бот остановлен, все ордера отменены');
    });

    this.bot.command('resume', async (ctx) => {
      if (this.risk.isPaused()) {
        this.risk.resume();
        ctx.reply('▶️ Risk-пауза снята. Сетку нужно перезапустить вручную.');
      } else {
        ctx.reply('ℹ️ Бот не на паузе');
      }
    });

    this.bot.command('advice', async (ctx) => {
      const latest = await this.claude.getLatestAdvice();
      if (!latest) {
        ctx.reply('ℹ️ Нет сохранённых советов Claude');
        return;
      }
      const a = latest.advice;
      ctx.reply(
        `🧠 <b>Claude (${latest.trigger})</b>\n\n` +
          `📊 ${a.market_assessment}\n\n` +
          `💡 <b>${a.grid_recommendation.action.toUpperCase()}</b>: ${a.grid_recommendation.reason}\n` +
          `📈 Уверенность: ${(a.confidence * 100).toFixed(0)}%\n` +
          (a.risk_flags.length > 0
            ? `⚠️ Риски: ${a.risk_flags.join(', ')}\n`
            : '') +
          `⏰ Следующий обзор: ${a.next_review_hours}ч`,
        { parse_mode: 'HTML' },
      );
    });
  }

  // ─── Callback buttons (Claude advice confirmation) ─────

  private registerCallbacks(): void {
    if (!this.bot) return;

    this.bot.action(/^apply_advice:(.+)$/, async (ctx) => {
      const adviceId = BigInt(ctx.match[1]);
      const applied = await this.claude.applyPendingAdvice(adviceId);
      if (applied) {
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply('✅ Совет Claude применён');
      } else {
        await ctx.reply('❌ Не удалось применить (уже применён или не найден)');
      }
    });

    this.bot.action(/^reject_advice:(.+)$/, async (ctx) => {
      await ctx.editMessageReplyMarkup(undefined);
      await ctx.reply('❌ Совет Claude отклонён');
    });
  }

  // ─── Status message builder ────────────────────────────

  private async buildStatusMessage(): Promise<string> {
    const grid = this.grid.getGrid();
    const riskSnap = this.risk.getCurrentRiskSnapshot();

    let price = 'N/A';
    try {
      const ticker = await this.exchange.fetchTicker(grid?.pair ?? 'BTC/USDT');
      price = `$${ticker.last?.toFixed(2)}`;
    } catch {
      /* skip */
    }

    const lines = [
      `<b>📊 Status</b>`,
      ``,
      `💰 Пара: ${grid?.pair ?? 'N/A'}`,
      `📈 Цена: ${price}`,
      `🔋 Grid: ${grid?.active ? '✅ Active' : '⏸ Inactive'}`,
    ];

    if (grid?.active) {
      const openOrders = grid.orders.filter(
        (o) => o.status === 'placed',
      ).length;
      lines.push(
        `📐 Диапазон: $${grid.lowerBound.toFixed(0)} — $${grid.upperBound.toFixed(0)}`,
        `📏 Шаг: ${grid.gridStepPct}%`,
        `📋 Ордеров: ${openOrders}`,
      );
    }

    lines.push(
      ``,
      `<b>⚠️ Risk</b>`,
      `Level: ${riskSnap.level.toUpperCase()}`,
      `Daily DD: ${riskSnap.dailyDrawdownPct.toFixed(1)}%`,
      `Weekly DD: ${riskSnap.weeklyDrawdownPct.toFixed(1)}%`,
      `Balance USDT: $${riskSnap.currentBalance.toFixed(2)}`,
      ...(this.risk.getEthBalance() > 0
        ? [`Balance ETH: ${this.risk.getEthBalance().toFixed(5)} (~$${(this.risk.getEthBalance() * this.risk.getLastKnownPrice()).toFixed(2)})`]
        : []),
    );

    return lines.join('\n');
  }

  // ─── PnL message builder ──────────────────────────────

  private async buildPnlMessage(): Promise<string> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const trades24h = await this.prisma.trade.findMany({
      where: { executedAt: { gte: dayAgo } },
    });
    const tradesWeek = await this.prisma.trade.findMany({
      where: { executedAt: { gte: weekAgo } },
    });

    const pnl24h = trades24h.reduce((s, t) => s + Number(t.pnlUsdt ?? 0), 0);
    const fees24h = trades24h.reduce((s, t) => s + Number(t.feeUsdt ?? 0), 0);
    const pnlWeek = tradesWeek.reduce((s, t) => s + Number(t.pnlUsdt ?? 0), 0);
    const feesWeek = tradesWeek.reduce((s, t) => s + Number(t.feeUsdt ?? 0), 0);

    const cycles24h = trades24h.filter((t) => t.pnlUsdt !== null).length;
    const profitable24h = trades24h.filter(
      (t) => Number(t.pnlUsdt ?? 0) > 0,
    ).length;

    return [
      `<b>💰 PnL Report</b>`,
      ``,
      `<b>24ч:</b>`,
      `  Сделок: ${trades24h.length} (${cycles24h} циклов)`,
      `  PnL: $${pnl24h.toFixed(2)}`,
      `  Fees: $${fees24h.toFixed(2)}`,
      `  Win rate: ${cycles24h > 0 ? ((profitable24h / cycles24h) * 100).toFixed(0) : 0}%`,
      ``,
      `<b>7 дней:</b>`,
      `  Сделок: ${tradesWeek.length}`,
      `  PnL: $${pnlWeek.toFixed(2)}`,
      `  Fees: $${feesWeek.toFixed(2)}`,
    ].join('\n');
  }

  // ─── Alerts (event-driven) ────────────────────────────

  @OnEvent(BOT_EVENTS.RISK_WARNING)
  async onRiskWarning(payload: RiskEventPayload): Promise<void> {
    await this.sendMessage(
      `⚠️ <b>RISK WARNING</b>\n\n${payload.reasons.join('\n')}\nDaily DD: ${payload.dailyDrawdownPct.toFixed(1)}%`,
    );
  }

  @OnEvent(BOT_EVENTS.RISK_PAUSE)
  async onRiskPause(payload: RiskEventPayload): Promise<void> {
    await this.sendMessage(
      `🛑 <b>RISK PAUSE — бот остановлен!</b>\n\n${payload.reasons.join('\n')}\nDaily DD: ${payload.dailyDrawdownPct.toFixed(1)}%\nWeekly DD: ${payload.weeklyDrawdownPct.toFixed(1)}%`,
    );
  }

  @OnEvent(BOT_EVENTS.PRICE_OUT_OF_RANGE)
  async onPriceOutOfRange(payload: {
    priceDeviationPct: number;
    currentPrice: number;
  }): Promise<void> {
    await this.sendMessage(
      `📉 <b>Цена вышла за сетку!</b>\n\nЦена: $${payload.currentPrice.toFixed(2)}\nОтклонение: ${payload.priceDeviationPct.toFixed(1)}%`,
    );
  }

  @OnEvent(BOT_EVENTS.REGIME_CHANGE)
  async onRegimeChange(payload: RegimeChangePayload): Promise<void> {
    await this.sendMessage(
      `🔄 <b>Смена режима рынка</b>\n\n${payload.oldRegime} → <b>${payload.newRegime}</b>\nУверенность: ${(payload.confidence * 100).toFixed(0)}%`,
    );
  }

  // ─── Claude advice with confirmation buttons ──────────

  @OnEvent(BOT_EVENTS.CLAUDE_ADVICE_PENDING)
  async onClaudeAdvicePending(
    payload: ClaudeAdvicePendingPayload,
  ): Promise<void> {
    await this.sendAdviceForConfirmation(
      payload.adviceId,
      payload.assessment,
      payload.action,
      payload.reason,
      payload.confidence,
    );
  }

  async sendAdviceForConfirmation(
    adviceId: bigint,
    assessment: string,
    action: string,
    reason: string,
    confidence: number,
  ): Promise<void> {
    const text =
      `🧠 <b>Claude рекомендует: ${action.toUpperCase()}</b>\n\n` +
      `📊 ${assessment}\n` +
      `💡 ${reason}\n` +
      `📈 Уверенность: ${(confidence * 100).toFixed(0)}%`;

    await this.sendMessage(
      text,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Применить', `apply_advice:${adviceId}`),
        Markup.button.callback('❌ Отклонить', `reject_advice:${adviceId}`),
      ]),
    );
  }

  // ─── Daily report at 00:00 ────────────────────────────

  @Cron('0 0 * * *')
  async dailyReport(): Promise<void> {
    const msg = await this.buildPnlMessage();
    await this.sendMessage(`📋 <b>Ежедневный отчёт</b>\n\n${msg}`);
  }

  // ─── Heartbeat every 15 min ───────────────────────────

  @Interval(HEARTBEAT_INTERVAL_MS)
  async heartbeat(): Promise<void> {
    this.lastHeartbeat = Date.now();
    this.logger.debug('Heartbeat ping');
  }

  getLastHeartbeat(): number {
    return this.lastHeartbeat;
  }

  isHealthy(): boolean {
    // If more than 20 min since last heartbeat — unhealthy
    return Date.now() - this.lastHeartbeat < 20 * 60 * 1000;
  }

  // ─── Send helpers ─────────────────────────────────────

  async sendMessage(text: string, extra?: object): Promise<void> {
    if (!this.bot || !this.chatId) return;
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        ...extra,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Telegram send failed: ${msg}`);
    }
  }
}
