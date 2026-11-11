# Curie DB designer (dbd) — ChartDB fork

This fork of [ChartDB](https://github.com/chartdb/chartdb) adds **Share / Publish**:
a diagram is still edited in the browser's own storage (stock ChartDB, IndexedDB),
and when you share or publish, a snapshot is copied to a server as a numbered
version behind a stable link. Anyone who opens the link gets the latest version
imported into their own browser.

It is not real-time collaboration. A version exists only when somebody presses
Publish (or an agent publishes through MCP).

Production host: mango (`mango.curie-money.com/dbd/`), which serves this build,
implements the API below against its Postgres (`dbd_*` tables) and exposes the
same operations as MCP tools at `/mcp/dbd`.

## What the fork changes

| File | Change |
|---|---|
| `src/lib/dbd/*` | API client, publish payload builder, local link store, version diff, three-way merge (`merge.ts`), change highlight store, update notice |
| `src/lib/dbml/dbml-table-groups.ts` | DBML `TableGroup` ↔ area, hooked into `dbml-import.ts` / `dbml-export.ts` (a few lines each) |
| `src/pages/editor-page/canvas/table-node/*` | change outline + badge on tables, tint on changed columns (one hook each in `table-node.tsx` / `table-node-field.tsx`) |
| `src/pages/editor-page/top-navbar/dbd-highlight-legend.tsx` | legend + clear for the highlight |
| `src/dialogs/share-dialog/share-dialog.tsx` | Share (first time) / Publish (new version) dialog |
| `src/pages/editor-page/top-navbar/share-button.tsx` | Share button in the top bar (replaces the GitHub stars iframe) |
| `src/pages/shared-diagram-page/shared-diagram-page.tsx` | `/s/:slug` and `/s/:slug/v/:version` — import a shared version and open it |
| `src/router.tsx` | the two routes above; router `basename` follows the Vite base |
| `vite.config.ts` | `VITE_BASE_PATH` (default `/`, mango uses `/dbd/`) |
| `src/lib/env.ts` | `DBD_API_BASE` (runtime `window.env` or `VITE_DBD_API_BASE`, default `<base>api`) |
| `dbd-dev/stub-server.mjs` | zero-dependency local implementation of the API, for development |

Storage (`src/context/storage-context/`) is untouched, so upstream releases merge cleanly.

## Local development

```bash
npm ci
node dbd-dev/stub-server.mjs            # API on http://127.0.0.1:4790/api, data in dbd-dev/.data/
VITE_DBD_API_BASE=http://127.0.0.1:4790/api npm run dev
```

## API contract

Base: `DBD_API_BASE` (mango: `/dbd/api`). JSON in and out. Auth is the host's
session cookie (same origin). If `GET /session` returns a `csrfToken`, every
POST sends it as `X-CSRF-Token`.

### Types

```ts
type ShareVersion = {
  slug: string;            // ^[a-z0-9][a-z0-9-]{1,62}$, stable link id
  title: string;
  version: number;         // 1, 2, 3 … per slug
  format: 'chartdb' | 'dbml';  // 'chartdb' = full diagram JSON (UI publishes);
                               // 'dbml' = DBML only (agent publishes; laid out on import)
  diagram: object | null;  // ChartDB diagram JSON (diagramToJSONOutput) when format = 'chartdb'
  dbml: string;            // always present — what agents read
  databaseType: string;    // ChartDB DatabaseType, e.g. 'postgresql'
  note: string;
  publishedBy: string;     // email
  publishedAt: string;     // ISO-8601
  source: 'ui' | 'mcp';
};
```

### Endpoints

| Method + path | Body | Success | Errors |
|---|---|---|---|
| `GET /session` | — | `{ user: {email, name}, canPublish: boolean, csrfToken?: string }` | 401 not signed in |
| `GET /shares` | — | `{ shares: [{slug, title, latestVersion, updatedAt, updatedBy}] }` | |
| `POST /shares` | `{slug, title, note, format, diagram, dbml, databaseType}` | 201 `ShareVersion` (version 1) | 400 bad slug · 403 no publish permission · 409 `{error:'slug_taken'}` |
| `GET /shares/:slug` | — | `ShareVersion` (latest) | 404 |
| `GET /shares/:slug/versions` | — | `{ versions: [{version, note, publishedBy, publishedAt, source}] }` newest first | 404 |
| `GET /shares/:slug/versions/:n` | — | `ShareVersion` | 404 |
| `POST /shares/:slug/versions` | `{baseVersion, force, note, format, diagram, dbml, databaseType}` | 201 `ShareVersion` (latest + 1) | 403 · 404 · 409 `{error:'stale_base', latestVersion, publishedBy, publishedAt}` when `baseVersion < latest` and `force` is false |

Versions are append-only: nothing updates or deletes a version row.

## Browser-side link state

The editor remembers which local diagram belongs to which link in `localStorage`
(`dbd:link:<diagramId>` → `{slug, version, syncedAt}`, `dbd:slug:<slug>` → `diagramId`).
Opening a link:

- no local copy → import it and remember the link;
- local copy with no edits since it was last synced → replace it in place, and
  show a notice in the editor of what that version changed, with anything it
  removed from your copy called out (`dbd-update-notice.tsx`);
- local copy with unsaved edits → ask: replace mine, open as a separate copy, or keep mine;
- a link to one specific version (`/s/<slug>/v/<n>`) that differs from the
  version your linked copy is on → opens as a separate "(vN)" copy, so an old
  link never rolls your copy back.

## Groups (DBML `TableGroup` ↔ ChartDB area)

`src/lib/dbml/dbml-table-groups.ts`, hooked into ChartDB's DBML import and export:

- **Import** (every DBML import path, including agent-published versions): each
  `TableGroup` becomes an area with its tables laid out inside it; ungrouped
  tables go below. `[color: #hex]` on the group is kept.
- **Export**: each area is written as `TableGroup "name" [color: …] { … }`, so the
  DBML that agents read through MCP carries the grouping and round-trips.

Importing DBML *into an existing diagram* (ChartDB's "Import" on a non-empty
canvas) still only merges tables; groups apply to new diagrams and shared links.

## Change review before publishing

`src/lib/dbd/diff.ts` compares two versions by table, column, relationship and
group name. The Share dialog shows:

- **Your changes since v*N*** — your copy against the version you took.
- When someone published after you took v*N*: who, when and their note, **their
  changes**, and the tables you **both** changed (highlighted). Publishing then
  needs an explicit "Publish anyway"; their version stays in the history.

**Highlight on diagram** puts the same comparison on the canvas: violet = your
change, amber = theirs, red = both. Each changed table gets an outline and a
label (hover it for the column-level list); changed columns are tinted. Tables
they added that your copy does not have are listed in the legend. The highlight
is display-only (`src/lib/dbd/highlight.ts`): it is never written to the diagram,
so it is not saved or published. It clears on Clear, on Publish, and when a
shared version is imported.

## Bringing in their changes (three-way merge)

When someone published after the version you took, the Publish dialog offers
**Bring in their changes** (`src/lib/dbd/merge.ts`). It takes the version you
started from (base), your copy (mine) and the latest version (theirs), matched
by table and column name:

- a change only they made is applied to your copy; a change only you made is
  kept; the same change on both sides is applied once;
- tables they added come with their relationships and land inside the group
  of the same name in your copy; groups they added or removed, and tables they
  moved between groups, follow;
- where you both changed the same column, or one side removed a table the
  other changed, the dialog asks per item: keep mine or take theirs.

Your copy is then based on the latest version, so the next Publish is an
ordinary one on top of theirs and nothing of theirs is dropped. "Publish
anyway" is still there for when you mean to replace their version.

Not merged: indexes and check constraints of tables both sides kept (yours
win), notes, custom types and dependencies.

