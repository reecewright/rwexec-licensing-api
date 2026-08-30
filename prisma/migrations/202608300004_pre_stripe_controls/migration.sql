-- Link licences to subscriptions, add audit history and webhook idempotency storage.
ALTER TABLE "License" ADD COLUMN "subscriptionId" TEXT;

-- Best-effort backfill for existing licences using the newest matching customer/product subscription.
UPDATE "License" l
SET "subscriptionId" = (
  SELECT s.id
  FROM "Subscription" s
  WHERE s."customerId" = l."customerId"
    AND s."productId" = l."productId"
  ORDER BY s."createdAt" DESC
  LIMIT 1
)
WHERE l."customerId" IS NOT NULL;

CREATE INDEX "License_subscriptionId_idx" ON "License"("subscriptionId");
ALTER TABLE "License" ADD CONSTRAINT "License_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "summary" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payloadHash" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");
CREATE INDEX "WebhookEvent_provider_type_idx" ON "WebhookEvent"("provider", "type");
