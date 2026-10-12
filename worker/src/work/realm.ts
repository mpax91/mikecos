import type { Context } from 'hono';

/** Work ↔ Personal (migration 0106). The app-wide switch in the top bar
 * (All / Personal / Work) rides on every request as an `X-Realm` header;
 * a `?realm=` query param overrides it (pickers that must see everything
 * pass `realm=all`). Missing / unknown = 'all'. */
export type Realm = 'personal' | 'work';
export type RealmFilter = 'all' | Realm;

export function realmOf(c: Context): RealmFilter {
  const raw = (c.req.query('realm') || c.req.header('x-realm') || '').toLowerCase();
  return raw === 'work' || raw === 'personal' ? raw : 'all';
}

/** The realm a NEW top-level item gets: Work only while the switch is on
 * Work (or the body asks for it) — All and Personal create personal items. */
export function createRealm(c: Context, explicit?: string | null): Realm {
  if (explicit === 'work' || explicit === 'personal') return explicit;
  return realmOf(c) === 'work' ? 'work' : 'personal';
}

/** ` AND <alias>.realm = 'work'` — empty for 'all'. The value is one of two
 * fixed literals, never user text, so inlining it is safe. */
export function realmSql(filter: RealmFilter, alias = ''): string {
  if (filter === 'all') return '';
  const col = alias ? `${alias}.realm` : 'realm';
  return ` AND ${col} = '${filter}'`;
}

export function realmMatches(filter: RealmFilter, realm: string | null | undefined): boolean {
  return filter === 'all' || (realm || 'personal') === filter;
}

/** Stamp a freshly inserted top-level entity with the request's create realm. */
export async function stampRealm(db: D1Database, c: Context, id: string, explicit?: string | null): Promise<void> {
  const realm = createRealm(c, explicit);
  if (realm === 'work') await db.prepare(`UPDATE entities SET realm = 'work' WHERE id = ?`).bind(id).run();
}

/** Set an entity's realm and every descendant's (projects → folders → tasks
 * → subtasks/attachments all move together). */
export async function cascadeRealm(db: D1Database, id: string, realm: Realm): Promise<void> {
  await db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT e.id FROM entities e JOIN tree t ON e.parent_id = t.id)
       UPDATE entities SET realm = ? WHERE id IN (SELECT id FROM tree)`
    )
    .bind(id, realm)
    .run();
}

/** After a move: a child takes its new parent's realm (cascaded). */
export async function inheritRealmFromParent(db: D1Database, id: string): Promise<void> {
  const row = await db
    .prepare(`SELECT e.realm AS own, p.realm AS parent FROM entities e JOIN entities p ON p.id = e.parent_id WHERE e.id = ?`)
    .bind(id)
    .first<{ own: string; parent: string }>();
  if (row && row.parent && row.parent !== row.own) await cascadeRealm(db, id, row.parent as Realm);
}
