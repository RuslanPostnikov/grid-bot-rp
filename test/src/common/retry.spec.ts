import { withRetry } from '@src/common/retry.js';

describe('withRetry', () => {
  it('should return result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, delayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, delayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after maxRetries exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, { maxRetries: 3, delayMs: 10 })).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws unreachable when maxRetries is 0 (loop never runs)', async () => {
    const fn = jest.fn().mockResolvedValue('x');
    await expect(withRetry(fn, { maxRetries: 0, delayMs: 1 })).rejects.toThrow(
      'Unreachable',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('logs error on final failure when logger is set', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    await expect(
      withRetry(jest.fn().mockRejectedValue(new Error('fatal')), {
        maxRetries: 1,
        delayMs: 1,
        logger: logger as never,
        context: 'ctx',
      }),
    ).rejects.toThrow('fatal');
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs warning between retries then succeeds', async () => {
    jest.useFakeTimers();
    const logger = { warn: jest.fn(), error: jest.fn() };
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('once'))
      .mockResolvedValueOnce('done');
    const p = withRetry(fn, {
      maxRetries: 3,
      delayMs: 8,
      logger: logger as never,
      context: 'ctx',
    });
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBe('done');
    expect(logger.warn).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('uses String(error) when last failure is not an Error', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    await expect(
      withRetry(jest.fn().mockRejectedValue('plain'), {
        maxRetries: 1,
        delayMs: 1,
        logger: logger as never,
      }),
    ).rejects.toBe('plain');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[retry] Failed after 1 attempts: plain'),
    );
  });

  it('warn path uses String for non-Error between retries', async () => {
    jest.useFakeTimers();
    const logger = { warn: jest.fn(), error: jest.fn() };
    const fn = jest
      .fn()
      .mockRejectedValueOnce('oops')
      .mockResolvedValueOnce('ok');
    const p = withRetry(fn, {
      maxRetries: 2,
      delayMs: 5,
      logger: logger as never,
    });
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('oops'));
    jest.useRealTimers();
  });

  it('final failure without logger still throws', async () => {
    await expect(
      withRetry(jest.fn().mockRejectedValue(new Error('x')), {
        maxRetries: 1,
        delayMs: 1,
      }),
    ).rejects.toThrow('x');
  });
});
