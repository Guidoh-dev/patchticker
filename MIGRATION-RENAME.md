# Domain rename: PatchPulse → PatchTicker

All source files, configs, schemas, and docs have been updated.
Two items require manual action on **existing** (already-running) deployments.
New deployments need nothing extra.

---

## 1. PostgreSQL role rename

The DB roles were renamed in all SQL files:

| Old | New |
|---|---|
| `patchpulse_owner` | `patchticker_owner` |
| `patchpulse_app` | `patchticker_app` |

**For an existing database**, run once as a superuser:

```sql
ALTER ROLE patchpulse_owner RENAME TO patchticker_owner;
ALTER ROLE patchpulse_app   RENAME TO patchticker_app;
```

Then update your `DATABASE_URL` connection string if it embeds the role name
(most connection strings use a login role, not the app role directly — check yours).

---

## 2. Stripe customer metadata key

The Stripe metadata key used to link customers to users was renamed:

| Old | New |
|---|---|
| `patchpulse_user_id` | `patchticker_user_id` |

This key is written when a Stripe customer is created and read in
`syncSubscription()` as a fallback user-lookup path.

**Primary lookup** is via the `subscriptions` table (`stripe_customer_id → user_id`)
and is unaffected. The metadata key is only used when the DB row is missing.

**For existing Stripe customers**, run a one-time migration:

```js
// scripts/migrate-stripe-metadata.js
// Run once: node scripts/migrate-stripe-metadata.js
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function migrate() {
  let hasMore = true, startingAfter;
  let updated = 0, skipped = 0;

  while (hasMore) {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter && { starting_after: startingAfter }),
    });

    for (const customer of page.data) {
      const oldKey = customer.metadata?.patchpulse_user_id;
      if (oldKey) {
        await stripe.customers.update(customer.id, {
          metadata: {
            patchticker_user_id: oldKey,
            patchpulse_user_id:  '',   // clear old key
          },
        });
        updated++;
      } else {
        skipped++;
      }
      startingAfter = customer.id;
    }

    hasMore = page.has_more;
  }

  console.log(`Done. Updated: ${updated}, Skipped: ${skipped}`);
}

migrate().catch(console.error);
```

---

## 3. Environment variables to update

In your `.env` / hosting platform:

```env
ALLOWED_ORIGINS=https://patchticker.app,https://www.patchticker.app
APP_URL=https://patchticker.app
EMAIL_FROM_ADDRESS=noreply@patchticker.app
```

## 4. DNS

Point `patchticker.app` and `www.patchticker.app` to your server/Cloudflare.
No application code changes required beyond the env vars above.
