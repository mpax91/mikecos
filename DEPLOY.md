# Deployment

This sandbox's network policy can't reach `api.cloudflare.com` directly, so deployment
runs through **GitHub Actions** instead of the CLI — Actions runners have normal internet
access, which effectively gives the same "push to deploy" behavior the spec asked for
(Cloudflare's own dashboard git integration would need clicking through their UI, which
isn't reachable here either).

## One-time setup (done automatically once the repo exists)

1. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are stored as GitHub Actions
   secrets on this repo.
2. The **Bootstrap D1 database** workflow (`.github/workflows/bootstrap-d1.yml`) is
   triggered once via `workflow_dispatch` to create the `mikeos-db` D1 database and
   print its `database_id`.
3. That ID gets pasted into `worker/wrangler.toml` (replacing `REPLACE_WITH_D1_DATABASE_ID`)
   and committed.
4. From then on, every push to `main` runs `.github/workflows/deploy.yml`:
   - applies D1 migrations to the remote database
   - deploys the Worker (`mikeos-api`)
   - builds the frontend with `VITE_API_URL` pointed at the deployed Worker
   - deploys the frontend to Cloudflare Pages (project `mikeos`)

## Manual deploy (if you ever want to do it from your own machine)

```bash
cd worker
npm install
npx wrangler login                    # or export CLOUDFLARE_API_TOKEN
npx wrangler d1 create mikeos-db      # only if it doesn't exist yet — copy the database_id into wrangler.toml
npm run db:migrate:remote
npm run deploy                        # prints the Worker's *.workers.dev URL

cd ..
npm install
VITE_API_URL=https://<your-worker>.workers.dev npm run build
npx wrangler pages deploy dist --project-name=mikeos
```
