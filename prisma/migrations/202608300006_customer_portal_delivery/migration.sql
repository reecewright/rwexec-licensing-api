-- Customer portal magic links and one-time encrypted licence delivery.
CREATE TABLE "CustomerPortalToken" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerPortalToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LicenseDelivery" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "authTag" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LicenseDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerPortalToken_tokenHash_key" ON "CustomerPortalToken"("tokenHash");
CREATE INDEX "CustomerPortalToken_customerId_expiresAt_idx" ON "CustomerPortalToken"("customerId", "expiresAt");
CREATE UNIQUE INDEX "LicenseDelivery_licenseId_key" ON "LicenseDelivery"("licenseId");
CREATE INDEX "LicenseDelivery_customerId_expiresAt_idx" ON "LicenseDelivery"("customerId", "expiresAt");

ALTER TABLE "CustomerPortalToken" ADD CONSTRAINT "CustomerPortalToken_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseDelivery" ADD CONSTRAINT "LicenseDelivery_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
