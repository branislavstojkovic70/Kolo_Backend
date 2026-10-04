-- CreateEnum
CREATE TYPE "BuyRequestStatus" AS ENUM ('ACTIVE', 'MATCHED', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ListingStatus" ADD VALUE 'RESERVED';
ALTER TYPE "ListingStatus" ADD VALUE 'SOLD';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "reservedForId" TEXT,
ADD COLUMN     "reservedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BuyRequest" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "maxPriceUsd" DECIMAL(18,2) NOT NULL,
    "status" "BuyRequestStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "matchedListingId" TEXT,
    "matchedOrderId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuyRequest_productId_status_idx" ON "BuyRequest"("productId", "status");

-- CreateIndex
CREATE INDEX "BuyRequest_buyerId_createdAt_idx" ON "BuyRequest"("buyerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_reservedForId_fkey" FOREIGN KEY ("reservedForId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyRequest" ADD CONSTRAINT "BuyRequest_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyRequest" ADD CONSTRAINT "BuyRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyRequest" ADD CONSTRAINT "BuyRequest_matchedListingId_fkey" FOREIGN KEY ("matchedListingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyRequest" ADD CONSTRAINT "BuyRequest_matchedOrderId_fkey" FOREIGN KEY ("matchedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
