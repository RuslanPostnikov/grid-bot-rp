const mockListen = jest.fn().mockResolvedValue(undefined);
const mockUseLogger = jest.fn();
const mockGet = jest.fn().mockReturnValue({});

const mockNestFactoryCreate = jest.fn().mockResolvedValue({
  useLogger: mockUseLogger,
  listen: mockListen,
  get: mockGet,
});

jest.mock('@src/app.module.js', () => ({
  AppModule: class AppModule {},
}));

jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: mockNestFactoryCreate,
  },
}));

jest.mock('nestjs-pino', () => ({
  Logger: class Logger {},
}));

import { bootstrap } from '@src/bootstrap.js';

describe('bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PORT;
  });

  it('creates Nest app, wires logger, listens on default port', async () => {
    await bootstrap();
    expect(mockNestFactoryCreate).toHaveBeenCalled();
    expect(mockUseLogger).toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalled();
    expect(mockListen).toHaveBeenCalledWith(3000);
  });

  it('uses PORT from env when set', async () => {
    process.env.PORT = '4000';
    await bootstrap();
    expect(mockListen).toHaveBeenCalledWith('4000');
  });
});
