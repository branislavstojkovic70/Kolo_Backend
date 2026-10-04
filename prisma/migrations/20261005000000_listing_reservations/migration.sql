-- Per-unit listing reservations.
--
-- Reservations used to be all-or-nothing: a matched listing went to status
-- RESERVED and the whole thing left the marketplace, and `soldCount` was bumped
-- at ORDER CREATION so an unpaid order held its unit forever.
--
-- From now on:
--   * soldCount counts PAID units only,
--   * an unpaid order holds its unit through a ListingReservation row,
--   * availableCount = quantity - soldCount - sum(active reservations),
--   * a partially reserved listing stays ACTIVE.
--
-- The data steps below therefore have to run BEFORE the columns are dropped and
-- BEFORE the enum loses RESERVED (the enum cast would fail on a RESERVED row).

-- CreateTable
CREATE TABLE "ListingReservation" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ListingReservation_orderId_key" ON "ListingReservation"("orderId");

-- CreateIndex
CREATE INDEX "ListingReservation_listingId_expiresAt_idx" ON "ListingReservation"("listingId", "expiresAt");

-- AddForeignKey
ALTER TABLE "ListingReservation" ADD CONSTRAINT "ListingReservation_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingReservation" ADD CONSTRAINT "ListingReservation_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingReservation" ADD CONSTRAINT "ListingReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DATA 1/3: every still-unpaid order now holds its unit through a reservation.
-- A listing that was RESERVED keeps the deadline it already had (reservedUntil);
-- manual pending orders never had one — they held their unit indefinitely via
-- soldCount — so they get a fresh standard window and the cron will settle them.
INSERT INTO "ListingReservation" ("id", "listingId", "buyerId", "orderId", "quantity", "expiresAt", "createdAt")
SELECT
    'lrsv_mig_' || o."id",
    o."listingId",
    o."buyerId",
    o."id",
    1,
    COALESCE(l."reservedUntil", now() + interval '15 minutes'),
    now()
FROM "Order" o
JOIN "Listing" l ON l."id" = o."listingId"
WHERE o."status" = 'PENDING_PAYMENT'
  AND l."status" <> 'DELETED';

-- DATA 2/3: soldCount becomes "units actually paid for". PAID, DISPUTED and
-- REFUNDED orders all consumed their unit (a refund after a lost dispute does
-- not put the goods back on the shelf); PENDING_PAYMENT is now a reservation and
-- EXPIRED holds nothing.
UPDATE "Listing" l
SET "soldCount" = COALESCE(settled."n", 0)
FROM (
    SELECT l2."id",
           (SELECT COUNT(*) FROM "Order" o
             WHERE o."listingId" = l2."id"
               AND o."status" IN ('PAID', 'DISPUTED', 'REFUNDED')) AS "n"
    FROM "Listing" l2
) settled
WHERE settled."id" = l."id";

-- DATA 3/3: RESERVED disappears, and SOLD_OUT (which used to mean "all units
-- claimed, paid or not") is recomputed against the new soldCount. Fully paid
-- listings become SOLD; everything else goes back on the marketplace. PAUSED and
-- DELETED are the seller's/system's own states and are left alone.
UPDATE "Listing"
SET "status" = CASE
        WHEN "soldCount" >= "quantity" THEN 'SOLD'::"ListingStatus"
        ELSE 'ACTIVE'::"ListingStatus"
    END
WHERE "status" IN ('RESERVED', 'SOLD_OUT', 'SOLD');

-- DropForeignKey
ALTER TABLE "Listing" DROP CONSTRAINT "Listing_reservedForId_fkey";

-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "reservedForId",
DROP COLUMN "reservedUntil";

-- AlterEnum
BEGIN;
CREATE TYPE "ListingStatus_new" AS ENUM ('ACTIVE', 'PAUSED', 'SOLD_OUT', 'SOLD', 'DELETED');
ALTER TABLE "public"."Listing" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Listing" ALTER COLUMN "status" TYPE "ListingStatus_new" USING ("status"::text::"ListingStatus_new");
ALTER TYPE "ListingStatus" RENAME TO "ListingStatus_old";
ALTER TYPE "ListingStatus_new" RENAME TO "ListingStatus";
DROP TYPE "public"."ListingStatus_old";
ALTER TABLE "Listing" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;
