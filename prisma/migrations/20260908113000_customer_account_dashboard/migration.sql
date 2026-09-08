ALTER TABLE "Customer"
ADD COLUMN "companyName" TEXT;

ALTER TABLE "Subscription"
ADD COLUMN "label" TEXT;

CREATE TABLE "CustomerEmailChangeToken" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "newEmail" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerEmailChangeToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerEmailChangeToken_tokenHash_key"
ON "CustomerEmailChangeToken"("tokenHash");

CREATE INDEX "CustomerEmailChangeToken_customerId_expiresAt_idx"
ON "CustomerEmailChangeToken"("customerId", "expiresAt");

CREATE INDEX "CustomerEmailChangeToken_newEmail_idx"
ON "CustomerEmailChangeToken"("newEmail");

ALTER TABLE "CustomerEmailChangeToken"
ADD CONSTRAINT "CustomerEmailChangeToken_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
