-- CreateTable
CREATE TABLE "grid_orders" (
    "id" BIGSERIAL NOT NULL,
    "grid_state_id" BIGINT NOT NULL,
    "level_index" INTEGER NOT NULL,
    "side" VARCHAR(5) NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "exchange_order_id" VARCHAR(100),
    "grid_cycle_id" VARCHAR(50),
    "placed_at" TIMESTAMPTZ,

    CONSTRAINT "grid_orders_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "grid_orders" ADD CONSTRAINT "grid_orders_grid_state_id_fkey" FOREIGN KEY ("grid_state_id") REFERENCES "grid_state"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
