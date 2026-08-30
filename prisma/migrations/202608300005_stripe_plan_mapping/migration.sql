-- Add Stripe catalogue mapping to plans.
ALTER TABLE "Plan"
ADD COLUMN "stripeProductId" TEXT,
ADD COLUMN "stripePriceId" TEXT;

CREATE UNIQUE INDEX "Plan_stripePriceId_key" ON "Plan"("stripePriceId");

-- Map the existing sandbox Reservations Business plan created during setup.
UPDATE "Plan"
SET
  "stripeProductId" = 'prod_VAZSyYy7mqRIbu',
  "stripePriceId" = 'price_1UAEJFClOsh1HxEhPkledVPp'
WHERE "slug" = 'business'
  AND "productId" IN (
    SELECT "id" FROM "Product" WHERE "slug" = 'rwexec-reservations'
  );
