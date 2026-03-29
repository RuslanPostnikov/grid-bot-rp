import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@src/prisma.service.js';

describe('PrismaService', () => {
  let service: PrismaService;
  let connectSpy: jest.SpiedFunction<PrismaService['$connect']>;
  let disconnectSpy: jest.SpiedFunction<PrismaService['$disconnect']>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    service = module.get(PrismaService);
    connectSpy = jest.spyOn(service, '$connect').mockResolvedValue(undefined);
    disconnectSpy = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);
  });

  it('connects on module init', async () => {
    await service.onModuleInit();
    expect(connectSpy).toHaveBeenCalled();
  });

  it('disconnects on module destroy', async () => {
    await service.onModuleDestroy();
    expect(disconnectSpy).toHaveBeenCalled();
  });
});
