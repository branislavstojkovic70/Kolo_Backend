-- AlterEnum
ALTER TYPE "ListingStatus" ADD VALUE 'SOLD_OUT';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "soldCount" INTEGER NOT NULL DEFAULT 0;
