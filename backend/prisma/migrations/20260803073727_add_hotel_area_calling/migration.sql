-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN "area" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "calling" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "guestCapacityMax" INTEGER;

-- CreateIndex
CREATE INDEX "Hotel_area_idx" ON "Hotel"("area");
