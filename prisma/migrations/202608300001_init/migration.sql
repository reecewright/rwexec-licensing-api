CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED');

CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyLastFour" TEXT NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "activationLimit" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "productId" TEXT NOT NULL,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Activation" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "pluginVersion" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    CONSTRAINT "Activation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");
CREATE UNIQUE INDEX "License_keyHash_key" ON "License"("keyHash");
CREATE INDEX "License_productId_idx" ON "License"("productId");
CREATE INDEX "License_customerId_idx" ON "License"("customerId");
CREATE INDEX "License_status_idx" ON "License"("status");
CREATE UNIQUE INDEX "Activation_licenseId_instanceId_key" ON "Activation"("licenseId", "instanceId");
CREATE INDEX "Activation_licenseId_deactivatedAt_idx" ON "Activation"("licenseId", "deactivatedAt");
CREATE INDEX "Activation_siteUrl_idx" ON "Activation"("siteUrl");

ALTER TABLE "License"
ADD CONSTRAINT "License_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "License"
ADD CONSTRAINT "License_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Activation"
ADD CONSTRAINT "Activation_licenseId_fkey"
FOREIGN KEY ("licenseId") REFERENCES "License"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
