-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "budgetDecorLakhs" DOUBLE PRECISION,
ADD COLUMN     "budgetEventsLakhs" DOUBLE PRECISION,
ADD COLUMN     "budgetHotelLakhs" DOUBLE PRECISION,
ADD COLUMN     "checkInDate" TIMESTAMP(3),
ADD COLUMN     "checkOutDate" TIMESTAMP(3),
ADD COLUMN     "createdByName" TEXT,
ADD COLUMN     "eventType" TEXT,
ADD COLUMN     "eventTypeOther" TEXT,
ADD COLUMN     "preferredHotel" TEXT,
ADD COLUMN     "relationshipManager" TEXT,
ADD COLUMN     "statusOther" TEXT;
