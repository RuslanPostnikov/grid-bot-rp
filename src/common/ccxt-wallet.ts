export type CcxtWallet = Record<string, number> | undefined;

export function ccxtWalletField(
  wallet: CcxtWallet,
  primary: string,
  alternate: string,
): number {
  if (wallet === undefined) return 0;
  return Number(wallet[primary] ?? wallet[alternate] ?? 0);
}

export function ccxtFreeUsedAssetTotal(
  balance: { free?: CcxtWallet; used?: CcxtWallet },
  primary: string,
  alternate: string,
): number {
  return (
    ccxtWalletField(balance.free, primary, alternate) +
    ccxtWalletField(balance.used, primary, alternate)
  );
}
