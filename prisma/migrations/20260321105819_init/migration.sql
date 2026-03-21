-- CreateTable
CREATE TABLE "candles" (
    "id" BIGSERIAL NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "timeframe" VARCHAR(5) NOT NULL,
    "open_time" TIMESTAMPTZ NOT NULL,
    "open" DECIMAL(65,30) NOT NULL,
    "high" DECIMAL(65,30) NOT NULL,
    "low" DECIMAL(65,30) NOT NULL,
    "close" DECIMAL(65,30) NOT NULL,
    "volume" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_regime" (
    "id" BIGSERIAL NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL,
    "regime" VARCHAR(20) NOT NULL,
    "confidence" DECIMAL(65,30) NOT NULL,
    "features" JSONB,

    CONSTRAINT "market_regime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grid_state" (
    "id" BIGSERIAL NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "lower_bound" DECIMAL(65,30) NOT NULL,
    "upper_bound" DECIMAL(65,30) NOT NULL,
    "grid_step_pct" DECIMAL(65,30) NOT NULL,
    "levels_count" INTEGER NOT NULL,
    "capital_usdt" DECIMAL(65,30) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "grid_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" BIGSERIAL NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "executed_at" TIMESTAMPTZ NOT NULL,
    "side" VARCHAR(5) NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "fee_usdt" DECIMAL(65,30) NOT NULL,
    "pnl_usdt" DECIMAL(65,30),
    "grid_cycle_id" VARCHAR(50),
    "exchange_order_id" VARCHAR(100),

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claude_advice" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "trigger_reason" VARCHAR(50),
    "context_snapshot" JSONB,
    "raw_response" TEXT,
    "parsed_advice" JSONB,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" TIMESTAMPTZ,

    CONSTRAINT "claude_advice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_log" (
    "id" BIGSERIAL NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL,
    "trigger" VARCHAR(50),
    "market_snapshot" JSONB,
    "ml_regime" VARCHAR(20),
    "action_taken" JSONB,
    "pnl_after_1h" DECIMAL(65,30),
    "pnl_after_24h" DECIMAL(65,30),

    CONSTRAINT "decision_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_performance" (
    "id" BIGSERIAL NOT NULL,
    "period_start" TIMESTAMPTZ,
    "period_end" TIMESTAMPTZ,
    "pair" VARCHAR(20),
    "total_trades" INTEGER,
    "profitable" INTEGER,
    "total_pnl_usdt" DECIMAL(65,30),
    "fees_paid_usdt" DECIMAL(65,30),
    "max_drawdown" DECIMAL(65,30),
    "roi_pct" DECIMAL(65,30),

    CONSTRAINT "bot_performance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candles_pair_timeframe_open_time_key" ON "candles"("pair", "timeframe", "open_time");
