-- CreateTable
CREATE TABLE "AttendanceOff" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceOff_employeeId_date_key" ON "AttendanceOff"("employeeId", "date");

-- CreateIndex
CREATE INDEX "AttendanceOff_employeeId_date_idx" ON "AttendanceOff"("employeeId", "date");

-- AddForeignKey
ALTER TABLE "AttendanceOff" ADD CONSTRAINT "AttendanceOff_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
