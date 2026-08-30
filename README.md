# RWExec Licensing API

Central commercial backend for RWExec products.

Version **0.3.0** expands the original Reservations licensing API into a multi-product customer, plan, subscription, entitlement and licence service with a built-in RWExec Admin dashboard.

## Products

The seed currently registers:

- `rwexec-reservations` — RWExec Reservations
- `rwexec-signage` — RWExec Signage

Additional RWExec products can be added through the admin dashboard or admin API.

## What v0.3.0 adds

- Licence records are now linked directly to the subscription that granted them.
- Licence activation/validation now checks that linked subscription entitlement is still active.
- Subscription management: edit plan/period, complimentary flag, suspend, reactivate, cancel now, or cancel at period end.
- Licence management: edit activation limit/expiry, suspend, revoke, reactivate, reset activations, and regenerate a replacement key.
- Replacement licence keys invalidate the previous raw key immediately and are displayed only once.
- Plan management: edit name, price, billing interval, active status, and entitlements.
- Audit log for commercial/admin changes.
- Webhook event persistence model ready for Stripe webhook idempotency.
- Admin API endpoints for subscription lifecycle, licence lifecycle, activation reset, key regeneration, and licence creation from a subscription.
- Existing customer management, RWExec branding, Reservations licensing endpoints, multi-product plans and Signage usage limits remain intact.

## RWExec Admin

After deployment, open:

`https://licensing.rwexec.com/admin`

Sign in using the current `ADMIN_API_KEY` Railway variable. The key is exchanged for a secure, HttpOnly, SameSite session cookie and is not stored in the browser as a normal preference/local-storage value.

The dashboard contains:

- Dashboard totals
- Customers
- Products
- Plans and entitlements
- Subscriptions
- Licences
- Audit log

The Licences page can create permanent complimentary licences by leaving the expiry date blank.

## Environment variables

Required:

```text
DATABASE_URL=postgresql://...
LICENSE_KEY_PEPPER=long-random-secret
ADMIN_API_KEY=different-long-random-secret
NODE_ENV=production
```

Do not rotate `LICENSE_KEY_PEPPER` after licences have been issued. Existing raw licence keys are hashed using this value.

`ADMIN_API_KEY` can be rotated when required; existing browser admin sessions will become invalid and administrators will sign in again with the new key.

Railway supplies `PORT` automatically.

## Railway deployment

`railway.json` is configured to:

1. Generate Prisma Client and build TypeScript during the build phase.
2. Run `npm run prisma:migrate:deploy` before deployment.
3. Start with `npm start`.
4. Health-check `/health`.

The production start path is `dist/src/server.js` because the TypeScript project includes both `src` and `prisma` under the project root.

v0.3.0 includes a database migration and Railway should apply it automatically via the configured pre-deploy command. No new seed data is required when upgrading from v0.2.3. If Railway ever deploys without applying the migration, run `npm run prisma:migrate:deploy` once in the service shell.

## Public licence endpoints

### Activate

`POST /v1/licenses/activate`

### Validate

`POST /v1/licenses/validate`

### Deactivate

`POST /v1/licenses/deactivate`

Example payload:

```json
{
  "license_key": "RWRES-XXXX-XXXX-XXXX-XXXX",
  "product": "rwexec-reservations",
  "site_url": "https://restaurant.example",
  "instance_id": "installation-uuid",
  "version": "0.11.0"
}
```

## Admin API

All `/v1/admin/*` requests require:

```text
X-RWExec-Admin-Key: <ADMIN_API_KEY>
```

Available resources now include:

- `GET /v1/admin/dashboard`
- `GET/POST /v1/admin/products`
- `GET /v1/admin/customers`
- `GET/POST /v1/admin/plans`
- `GET/POST /v1/admin/subscriptions`
- `PATCH /v1/admin/subscriptions/:id`
- `GET/POST /v1/admin/licenses`
- `POST /v1/admin/licenses/from-subscription`
- `GET/PATCH /v1/admin/licenses/:id`
- `POST /v1/admin/licenses/:id/reset-activations`
- `POST /v1/admin/licenses/:id/regenerate`
- `GET /v1/admin/audit`

The raw full licence key is returned only at creation. The database stores only its HMAC hash and last four characters.

## Commercial model

Reservations and Signage can share one customer while using different entitlement styles:

- **RWExec Reservations:** site activation licences, update/support/premium-feature entitlement.
- **RWExec Signage:** account subscription with a numeric screen/device allowance, e.g. `screens = 5`.

A future Stripe integration should create/update `Subscription` rows from verified Stripe webhooks. The product clients should consume subscription/entitlement state from the RWExec backend rather than talk directly to Stripe.

Core restaurant reservation operation should not be destroyed or data-locked merely because a subscription expires. Entitlements should control commercial services such as updates, support and premium capabilities.

## Local development

```bash
npm install
npm run prisma:generate
npm run prisma:migrate:dev
npm run seed
npm run dev
```

## Security notes

- Never commit `.env` or Railway secret values.
- Keep `LICENSE_KEY_PEPPER` and `ADMIN_API_KEY` different.
- Admin JSON routes use timing-safe API-key comparison.
- Admin browser sessions are signed using the admin secret and use HttpOnly/SameSite cookies.
- Production should remain HTTPS-only.
- Stripe webhook signing secrets, when added, must be separate secrets and verified on every webhook.


## v0.2.2
- Added editable customer account email, customer/business name and optional billing email.
- Added customer detail pages with subscription and licence history.
- Added customer update endpoint to the admin API.
- Manual subscriptions can capture a billing email.
- Updated admin branding to use the transparent RWExec logo supplied for the dashboard.


## v0.2.3

- Licence creation now starts from an existing active, trial or complimentary customer subscription.
- Customer, product, plan and subscription status are inherited automatically when a licence is generated.
- Removed duplicate customer email/name entry from the admin licence form.
- No database migration is required from v0.2.2.


## v0.3.0

This is the pre-Stripe commercial-control release. It establishes the lifecycle actions and subscription-to-licence relationship that Stripe webhooks will update later, without adding Stripe credentials or payment processing yet.
