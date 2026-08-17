-- CreateTable
CREATE TABLE "Artist" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "gender" TEXT,
    "place" TEXT,
    "agencyName" TEXT,
    "agencyPhone" TEXT,
    "budget" TEXT,
    "budgetNote" TEXT,
    "peopleTraveling" TEXT,
    "instagramLink" TEXT,
    "driveLink" TEXT,
    "techRider" TEXT,
    "additionalInfo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'artist-sheet',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artist_category_idx" ON "Artist"("category");

-- CreateIndex
CREATE INDEX "Artist_place_idx" ON "Artist"("place");
