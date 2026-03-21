export interface GridParams {
  lowerBound: number;
  upperBound: number;
  gridStepPct: number;
  levelsCount: number;
  levels: number[];
}

export interface GridInput {
  currentPrice: number;
  atr14: number;
  capital: number;
}

export type MarketVolatility = 'low' | 'normal' | 'high';

export interface GridLevel {
  price: number;
  side: 'buy' | 'sell';
  quantity: number;
}

export interface GridOrder {
  levelIndex: number;
  price: number;
  side: 'buy' | 'sell';
  quantity: number;
  status: 'pending' | 'placed' | 'filled' | 'cancelled';
  exchangeOrderId?: string;
  gridCycleId?: string;
}

export type RebalanceTrigger =
  | 'time_24h'
  | 'price_upper_zone'
  | 'price_lower_zone'
  | 'atr_increase'
  | 'atr_decrease';

export interface RebalanceResult {
  trigger: RebalanceTrigger;
  newLowerBound: number;
  newUpperBound: number;
  newGridStepPct: number;
}
