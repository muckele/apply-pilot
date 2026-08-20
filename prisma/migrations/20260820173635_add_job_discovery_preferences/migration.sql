-- CreateTable
CREATE TABLE "JobDiscoveryPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetSearches" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "location" TEXT NOT NULL DEFAULT '',
    "limitPerQuery" INTEGER NOT NULL DEFAULT 8,
    "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
    "scoreImported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobDiscoveryPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobDiscoveryPreference_userId_key" ON "JobDiscoveryPreference"("userId");

-- AddForeignKey
ALTER TABLE "JobDiscoveryPreference" ADD CONSTRAINT "JobDiscoveryPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
