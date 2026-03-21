import { Logger } from '@nestjs/common';

export interface RetryOptions {
  maxRetries: number;
  delayMs: number;
  backoffMultiplier?: number;
  logger?: Logger;
  context?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, delayMs, backoffMultiplier = 2, logger, context } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLast = attempt === maxRetries;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (isLast) {
        logger?.error(
          `[${context ?? 'retry'}] Failed after ${maxRetries} attempts: ${errorMsg}`,
        );
        throw error;
      }

      const wait = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      logger?.warn(
        `[${context ?? 'retry'}] Attempt ${attempt}/${maxRetries} failed: ${errorMsg}. Retrying in ${wait}ms...`,
      );
      await sleep(wait);
    }
  }

  throw new Error('Unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
