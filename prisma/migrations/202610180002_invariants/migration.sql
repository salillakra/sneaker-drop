ALTER TABLE "Product" ADD CONSTRAINT "valid_inventory"
  CHECK ("totalStock" = 20 AND "availableStock" >= 0 AND "availableStock" <= "totalStock");
ALTER TABLE "Reservation" ADD CONSTRAINT "one_pair_per_reservation" CHECK (quantity = 1);
ALTER TABLE "Order" ADD CONSTRAINT "one_pair_per_order" CHECK (quantity = 1);
CREATE UNIQUE INDEX "one_active_reservation_per_user" ON "Reservation" ("userId")
  WHERE status IN ('ACTIVE', 'PAYMENT_PENDING');
CREATE UNIQUE INDEX "one_waiting_entry_per_user" ON "QueueEntry" ("userId")
  WHERE status = 'WAITING';
