import { Hono } from 'hono';
import type { Env } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Bookmarks — a periodic, manual mirror of a Chrome bookmarks export.
 * See migrations/0060_bookmarks.sql for the schema and why it's kept
 * separate from both quick_links (Links' small hand-curated tray) and the
 * shared `entities` tree. Mounted at /api/bookmarks. There's no live sync
 * here at all — Settings > Links > Import Bookmarks uploads a fresh
 * bookmarks.html, and that one upload fully replaces whatever's here. */
export const bookmarksRouter = new Hono<{ Bindings: Env }>();

interface BookmarkRow {
  id: string;
  parent_id: string | null;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  sort_order: number;
  imported_at: string;
}

interface BookmarkNode {
  id: string;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  children: BookmarkNode[];
}

function rowsToTree(rows: BookmarkRow[]): BookmarkNode[] {
  const byId = new Map<string, BookmarkNode>();
  for (const r of rows) byId.set(r.id, { id: r.id, type: r.type, title: r.title, url: r.url, children: [] });
  const roots: BookmarkNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// GET /api/bookmarks — the full imported tree, plus when it was last
// imported (every row from one import shares the same imported_at, so the
// max across the table doubles as that without a separate metadata row).
bookmarksRouter.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM bookmarks ORDER BY sort_order ASC').all<BookmarkRow>();
  const rows = results ?? [];
  const linkCount = rows.filter((r) => r.type === 'link').length;
  const folderCount = rows.filter((r) => r.type === 'folder').length;
  const lastImportedAt = rows.length > 0 ? rows.reduce((max, r) => (r.imported_at > max ? r.imported_at : max), rows[0].imported_at) : null;
  return c.json({ nodes: rowsToTree(rows), linkCount, folderCount, lastImportedAt });
});

// DELETE /api/bookmarks — clears everything without requiring a fresh
// file to replace it with (Settings' own "Clear" affordance).
bookmarksRouter.delete('/', async (c) => {
  await c.env.DB.prepare('DELETE FROM bookmarks').run();
  return c.json({ ok: true });
});

interface ParsedNode {
  type: 'folder' | 'link';
  title: string;
  url?: string;
  children: ParsedNode[];
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

// Chrome's bookmarks export is the standard "Netscape Bookmark File
// Format" — a nested <DL> tree with no closing </DT>/<p> tags to rely on,
// which is why this walks a flat stream of tokens (folder-open,
// link, list-open, list-close) rather than treating it as real markup.
// Cloudflare Workers have no DOM/DOMParser to lean on anyway, and the
// format is regular enough that a small hand-rolled scan is both simpler
// and more robust than pulling in an HTML-parsing dependency for it — same
// call this codebase already made for ICS and IMAP (see ics.ts,
// imapClient.ts).
//
// The trick: a <DL> immediately follows the <H3> whose folder it belongs
// to, but a <DL>/</DL> token carries no identifying info of its own. So a
// folder <H3> is held as `pendingFolder` until the very next <DL> token
// consumes it (pushing that folder's children array as the new write
// target); the very first <DL> in the document — before any <H3> — has no
// pendingFolder, and lands back on the synthetic root instead, which is
// exactly the "no wrapper folder for the top level" behavior this wants.
function parseBookmarksHtml(html: string): ParsedNode[] {
  const root: ParsedNode = { type: 'folder', title: '', children: [] };
  const stack: ParsedNode[] = [root];
  let pendingFolder: ParsedNode | null = null;

  const TOKEN_RE = /<DT>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A([^>]*)>([\s\S]*?)<\/A>|<DL>|<\/DL>/gi;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(html))) {
    if (m[2] !== undefined) {
      // <DT><H3 ...>Folder title</H3>
      const node: ParsedNode = { type: 'folder', title: unescapeHtml(m[2].trim()) || 'Untitled folder', children: [] };
      stack[stack.length - 1].children.push(node);
      pendingFolder = node;
    } else if (m[4] !== undefined) {
      // <DT><A HREF="...">Link title</A>
      const hrefMatch = /href\s*=\s*"([^"]*)"/i.exec(m[3] ?? '');
      const url = hrefMatch ? unescapeHtml(hrefMatch[1]) : '';
      if (url) {
        const title = unescapeHtml(m[4].trim()) || url;
        stack[stack.length - 1].children.push({ type: 'link', title, url, children: [] });
      }
    } else if (m[0].toUpperCase() === '<DL>') {
      stack.push(pendingFolder ?? stack[stack.length - 1]);
      pendingFolder = null;
    } else {
      // </DL> — the outermost one closes the synthetic root itself, so
      // never pop past it even if the file has an extra stray close tag.
      if (stack.length > 1) stack.pop();
    }
  }
  return root.children;
}

function countNodes(nodes: ParsedNode[]): { folders: number; links: number } {
  let folders = 0;
  let links = 0;
  for (const n of nodes) {
    if (n.type === 'folder') {
      folders++;
      const sub = countNodes(n.children);
      folders += sub.folders;
      links += sub.links;
    } else {
      links++;
    }
  }
  return { folders, links };
}

// D1's batch() call is happy with far more than this, but chunking keeps
// any single import — even a many-thousand-bookmark one — well clear of
// per-request statement/time limits, matching the same bounded-batch
// convention the contacts importer uses (see processDecisionChunk).
const INSERT_CHUNK_SIZE = 150;

// POST /api/bookmarks/import — multipart/form-data with a "file" field
// (the exported bookmarks.html/.htm). Fully replaces whatever's already
// in the table: Chrome is the source of truth here, this is a snapshot of
// it, not something merged or hand-edited in place.
bookmarksRouter.post('/import', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const rawFile = form?.get('file');
  if (!rawFile || typeof rawFile === 'string') return c.json({ error: 'file is required' }, 400);
  const file = rawFile as File;

  const html = await file.text();
  const tree = parseBookmarksHtml(html);
  const { folders, links } = countNodes(tree);
  if (folders === 0 && links === 0) {
    return c.json({ error: "Couldn't find any bookmarks in that file — make sure it's a bookmarks export from Chrome (⋮ menu → Bookmarks and lists → Export bookmarks)." }, 400);
  }

  const ts = now();
  const stmts: { id: string; parent_id: string | null; type: 'folder' | 'link'; title: string; url: string | null; sort_order: number }[] = [];
  let order = 0;
  function flatten(nodes: ParsedNode[], parentId: string | null) {
    for (const n of nodes) {
      const id = uid();
      stmts.push({ id, parent_id: parentId, type: n.type, title: n.title, url: n.url ?? null, sort_order: order++ });
      if (n.type === 'folder') flatten(n.children, id);
    }
  }
  flatten(tree, null);

  await c.env.DB.prepare('DELETE FROM bookmarks').run();
  for (let i = 0; i < stmts.length; i += INSERT_CHUNK_SIZE) {
    const chunk = stmts.slice(i, i + INSERT_CHUNK_SIZE);
    await c.env.DB.batch(
      chunk.map((s) =>
        c.env.DB.prepare('INSERT INTO bookmarks (id, parent_id, type, title, url, sort_order, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
          s.id,
          s.parent_id,
          s.type,
          s.title,
          s.url,
          s.sort_order,
          ts
        )
      )
    );
  }

  return c.json({ folderCount: folders, linkCount: links, importedAt: ts });
});
