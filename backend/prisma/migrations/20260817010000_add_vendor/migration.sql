-- CreateTable
CREATE TABLE "Vendor" (
    "id" SERIAL NOT NULL,
    "categories" TEXT[],
    "serviceDetail" TEXT,
    "company" TEXT NOT NULL,
    "personContactedName" TEXT,
    "primaryPhone" TEXT,
    "secondaryPhone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "remark" TEXT,
    "source" TEXT NOT NULL DEFAULT 'vendor-sheet',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vendor_city_idx" ON "Vendor"("city");
