-- CreateTable
CREATE TABLE "Feedback" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "screen" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");

-- CreateIndex
CREATE INDEX "Feedback_employeeId_idx" ON "Feedback"("employeeId");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
