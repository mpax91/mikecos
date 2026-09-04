# MikeOS

Personal life operating system — V1.0 ships one functional section, **Projects**,
built on a flexible `entities` + `links` data model designed to support every future
module (Today, Inbox, CRM, RSS, calendar) without a schema rewrite.

See [`mikeos-v1-build-spec.md`](./mikeos-v1-build-spec.md) for the full spec this build follows.

## Stack

- **Frontend:** React 19 + Vite PWA, React Router, Tiptap (note editor), dnd-kit (drag-and-drop)
- **Backend:** Cloudflare Worker (Hono) + Cloudflare D1
- **Hosting:** Cloudflare Pages (frontend) + Workers (API)

## Structure

```
/                 frontend (Vite React PWA)
/worker           Cloudflare Worker API + D1 migrations
```

## Local development

### 1. API (Worker + local D1)

```bash
cd worker
npm install
npm run db:migrate:local   # applies migrations/0001_init.sql to a local D1 sqlite file
npm run dev                 # wrangler dev on http://localhost:8787
```

### 2. Frontend

```bash
npm install
cp .env.example .env.local  # VITE_API_URL=http://localhost:8787
npm run dev                 # vite on http://localhost:5173
```

## Deployment

### Worker + D1

```bash
cd worker
npx wrangler d1 create mikeos-db          # once — copy the returned database_id into wrangler.toml
npm run db:migrate:remote                  # applies migrations to the remote D1 database
npm run deploy                             # deploys the Worker to Cloudflare
```

### Frontend (Cloudflare Pages)

Build output is `dist/`. Set the `VITE_API_URL` environment variable (in the Pages project
settings, or a `.env.production` file) to the deployed Worker's URL before building, e.g.
`https://mikeos-api.<your-subdomain>.workers.dev`.

```bash
npm run build
npx wrangler pages deploy dist --project-name=mikeos
```

## Data model

A single `entities` table (type: `project` | `folder` | `note` | `task`) plus a `links`
table for freeform relationships. A **project** is `type='project', is_top_level=1`;
everything else nests under it via `parent_id`. See `worker/migrations/0001_init.sql`.
