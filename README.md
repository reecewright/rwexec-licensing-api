# RWExec Licensing API

Central commercial backend for RWExec products.

Version **0.2.0** expands the original Reservations licensing API into a multi-product customer, plan, subscription, entitlement and licence service with a built-in RWExec Admin dashboard.

## Products

The seed currently registers:

- `rwexec-reservations` — RWExec Reservations
- `rwexec-signage` — RWExec Signage

Additional RWExec products can be added through the admin dashboard or admin API.

## What v0.2.0 adds

- Multi-product catalogue
- Customers shared across RWExec products
- Plans with price/billing metadata
- Boolean and numeric-limit entitlements
- Subscriptions, including complimentary/manual subscriptions
- External billing IDs ready for a later Stripe webhook integration
- Usage counters ready for limits such as Signage screen/device allowances
- Internal RWExec Admin dashboard
- Manual complimentary licence creation from the browser
- Existing Reservations activate / validate / deactivate API retained
- Existing admin API retained and expanded

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

After deploying v0.2.0, run once in the Railway service shell:

```bash
npm run seed
```

This keeps RWExec Reservations and adds RWExec Signage to the product table.

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
- `GET/POST /v1/admin/licenses`
- `GET /v1/admin/licenses/:id`

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
