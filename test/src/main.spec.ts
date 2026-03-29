const bootstrapMock = jest.fn<[], Promise<void>>();
bootstrapMock.mockResolvedValue(undefined);

jest.mock('@src/bootstrap.js', () => ({
  bootstrap: (): Promise<void> => bootstrapMock() as Promise<void>,
}));

describe('main', () => {
  it('invokes bootstrap on load', async () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@src/main.js');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bootstrapMock).toHaveBeenCalled();
  });
});
