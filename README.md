# RWExec Licensing API

Railway-ready licensing backend for RWExec software products.

Version: **0.1.0**

## Included

- Node.js + TypeScript
- Express REST API
- PostgreSQL
- Prisma ORM
- Hashed licence keys using HMAC-SHA256 + server-side pepper
- Multiple RWExec products
- Customer records
- Licence expiry/status
- Per-licence activation limits
- Per-installation UUID binding
- Site URL binding
- Activate / validate / deactivate endpoints
- Protected admin licence creation endpoint
- Railway deployment config
- Health endpoint
- Rate limiting
- Helmet security headers

The full raw licence key is not stored in the database. The API stores an HMAC hash plus the last four characters for identification.

## API structure

Public plugin endpoints:

- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`
- `POST /v1/licenses/deactivate`

Internal/admin endpoints:

- `POST /v1/admin/licenses`
- `GET /v1/admin/licenses/:id`

Health check:

- `GET /health`

## Railway setup

Create a new service for this project and a PostgreSQL database in Railway.

Set these environment variables on the API service:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
LICENSE_KEY_PEPPER=<long random secret>
ADMIN_API_KEY=<long random secret>
NODE_ENV=production
```

Railway supplies `PORT` automatically. The application defaults to port 3000 locally.

`railway.json` runs:

1. `npm ci`
2. `prisma generate`
3. TypeScript build
4. `prisma migrate deploy`
5. `npm start`

The Railway health check is `/health`.

After the first deployment, seed the RWExec Reservations product once:

```bash
npm run seed
```

You can run this from a Railway shell or locally against the Railway database.

## Suggested domain

Point:

`licensing.rwexec.com`

to the Railway licensing API service.

The plugin will later use:

```text
https://licensing.rwexec.com/v1/licenses/activate
https://licensing.rwexec.com/v1/licenses/validate
https://licensing.rwexec.com/v1/licenses/deactivate
```

## Create a licence manually

Send:

```http
POST /v1/admin/licenses
X-RWExec-Admin-Key: YOUR_ADMIN_API_KEY
Content-Type: application/json
```

Body:

```json
{
  "product": "rwexec-reservations",
  "customer_email": "customer@example.com",
  "customer_name": "Example Customer",
  "activation_limit": 1,
  "expires_at": "2027-08-30T23:59:59Z"
}
```

Example response:

```json
{
  "id": "licence-record-id",
  "license_key": "RWRES-ABCD-EFGH-JKLM-NPQR",
  "product": "rwexec-reservations",
  "status": "active",
  "activation_limit": 1,
  "expires_at": "2027-08-30T23:59:59.000Z",
  "note": "This is the only response containing the full raw licence key."
}
```

Save or deliver the returned licence key because the server does not retain the plaintext value.

## Activate from a WordPress plugin

```http
POST /v1/licenses/activate
Content-Type: application/json
```

```json
{
  "license_key": "RWRES-ABCD-EFGH-JKLM-NPQR",
  "product": "rwexec-reservations",
  "site_url": "https://restaurant.example",
  "instance_id": "0ce206d0-777e-4b0a-af9c-672e1c92681d",
  "version": "0.11.0"
}
```

Successful response:

```json
{
  "valid": true,
  "status": "active",
  "expires_at": "2027-08-30T23:59:59.000Z",
  "activation_limit": 1,
  "activations": 1,
  "activation_id": "activation-record-id"
}
```

The same payload is used for `/validate` and `/deactivate`.

## Licence behaviour

A licence can be:

- active
- expired
- suspended
- revoked

Activation is tied to both:

- WordPress site URL
- a generated installation UUID (`instance_id`)

A licence can be re-activated by the same installation without consuming another activation.

Deactivation releases the activation slot.

## Security notes

- Do not commit `.env`.
- Use long randomly generated values for `LICENSE_KEY_PEPPER` and `ADMIN_API_KEY`.
- Never expose `ADMIN_API_KEY` inside a WordPress plugin.
- Keep all administrative licence creation on your own backend/server-side systems.
- The API only returns the full raw licence key at creation time.
- Railway should terminate HTTPS for the service/custom domain.
- The future WordPress client should cache successful validation and use a grace period if the licensing API is temporarily unreachable.

## Next build

The next stage is the RWExec Reservations WordPress client:

- Settings → Licence tab
- licence key input
- Activate Licence
- Deactivate Licence
- status/expiry display
- installation UUID
- automatic validation
- cached successful validation/grace period
- later, entitlement-based automatic updates

Payment/Stripe integration remains separate. Stripe webhooks can later create and renew licence records through internal server-side logic without changing the WordPress plugin API.
