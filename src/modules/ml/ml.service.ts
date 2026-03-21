import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service.js';
import {
  calculateMarketFeatures,
  calculateAvgBBWidth,
  calculateAvgAtrPct,
  type CandleInput,
} from './market-features.js';
import {
  classifyRegime,
  regimeToAction,
  type ClassificationResult,
  type GridAction,
} from './regime-classifier.js';

@Injectable()
export class MlService {
  private readonly logger = new Logger(MlService.name);

  constructor(private readonly prisma: PrismaService) {}

  async classifyCurrentRegime(
    pair: string,
    timeframe: string = '4h',
  ): Promise<{ classification: ClassificationResult; action: GridAction } | null> {
    const candles = await this.prisma.candle.findMany({
      where: { pair, timeframe },
      orderBy: { openTime: 'desc' },
      take: 100,
    });

    if (candles.length < 60) {
      this.logger.warn(
        `Not enough candles for ${pair} ${timeframe}: ${candles.length}/60`,
      );
      return null;
    }

    // Reverse to chronological order
    candles.reverse();

    const inputs: CandleInput[] = candles.map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }));

    const features = calculateMarketFeatures(inputs);
    if (!features) return null;

    const avgBBWidth = calculateAvgBBWidth(inputs);
    const avgAtrPct = calculateAvgAtrPct(inputs);

    const classification = classifyRegime(features, avgBBWidth, avgAtrPct);
    const action = regimeToAction(classification.regime);

    // Save to DB
    await this.prisma.marketRegime.create({
      data: {
        pair,
        detectedAt: new Date(),
        regime: classification.regime,
        confidence: classification.confidence,
        features: JSON.parse(JSON.stringify(features)),
      },
    });

    this.logger.log(
      `${pair}: regime=${classification.regime} confidence=${classification.confidence} action=${action}`,
    );

    return { classification, action };
  }
}
