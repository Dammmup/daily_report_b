# Deployment checklist

Required production variables:

- `JWT_SECRET`: a strong random value.
- `INTEGRATION_ENCRYPTION_KEY`: a separate strong random value.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: required before the first database bootstrap.
- `CRON_SECRET`: at least 16 characters; Vercel Cron sends it as a bearer token.
- `ALLOWED_ORIGINS`: comma-separated frontend origins.
- `BUSINESS_TIME_ZONE`: `Asia/Almaty`.

Database migrations and admin seeding no longer run during serverless cold starts. Run them explicitly after deploying schema or migration changes:

```bash
npm run db:bootstrap
```

The command is idempotent and should be run with the production MongoDB environment variables.

Verification before deployment:

```bash
npm test
npm run build
```
