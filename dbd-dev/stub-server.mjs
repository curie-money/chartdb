#!/usr/bin/env node
// Local stand-in for mango's /dbd/api (see ../DBD.md). Development only.
// Zero dependencies. Data lives in dbd-dev/.data/store.json.
//
//   node dbd-dev/stub-server.mjs                     # http://127.0.0.1:4790/api
//   DBD_STUB_USER=you@example.com DBD_STUB_PORT=4790 node dbd-dev/stub-server.mjs

/* global process */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DBD_STUB_PORT ?? 4790);
const USER = process.env.DBD_STUB_USER ?? 'dev@localhost';
const DATA_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '.data'
);
const STORE = path.join(DATA_DIR, 'store.json');
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

const load = () => {
    try {
        return JSON.parse(fs.readFileSync(STORE, 'utf8'));
    } catch {
        return { shares: {} };
    }
};
const save = (store) => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
};

const send = (req, res, status, body) => {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (req) =>
    new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });

const visibleTo = (share) =>
    (share.visibility ?? 'shared') === 'shared' || share.createdBy === USER;

const toVersion = (share, v) => ({
    slug: share.slug,
    title: share.title,
    visibility: share.visibility ?? 'shared',
    owner: share.createdBy ?? share.versions[0].publishedBy,
    version: v.version,
    format: v.format,
    diagram: v.diagram ?? null,
    dbml: v.dbml,
    databaseType: v.databaseType,
    note: v.note ?? '',
    publishedBy: v.publishedBy,
    publishedAt: v.publishedAt,
    source: v.source,
});

const validPayload = (b) =>
    (b.format === 'chartdb' && b.diagram && typeof b.dbml === 'string') ||
    (b.format === 'dbml' && typeof b.dbml === 'string' && b.dbml.trim());

const newVersion = (b, version) => ({
    version,
    format: b.format,
    diagram: b.format === 'chartdb' ? b.diagram : null,
    dbml: b.dbml,
    databaseType: b.databaseType ?? 'generic',
    note: String(b.note ?? ''),
    publishedBy: USER,
    publishedAt: new Date().toISOString(),
    source: b.source === 'mcp' ? 'mcp' : 'ui',
});

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Accept, X-CSRF-Token'
        );
        return send(req, res, 204);
    }

    const url = new URL(req.url, 'http://local');
    const parts = url.pathname
        .replace(/^\/api/, '')
        .split('/')
        .filter(Boolean);
    const store = load();

    try {
        if (
            req.method === 'GET' &&
            parts[0] === 'session' &&
            parts.length === 1
        ) {
            return send(req, res, 200, {
                user: { email: USER, name: USER.split('@')[0] },
                canPublish: true,
                csrfToken: 'stub-csrf',
            });
        }

        if (parts[0] !== 'shares')
            return send(req, res, 404, { error: 'not_found' });

        if (parts.length === 1 && req.method === 'GET') {
            return send(req, res, 200, {
                shares: Object.values(store.shares)
                    .filter(visibleTo)
                    .map((s) => {
                        const last = s.versions[s.versions.length - 1];
                        return {
                            slug: s.slug,
                            title: s.title,
                            latestVersion: last.version,
                            updatedAt: last.publishedAt,
                            updatedBy: last.publishedBy,
                            visibility: s.visibility ?? 'shared',
                        };
                    }),
            });
        }

        if (parts.length === 1 && req.method === 'POST') {
            if (req.headers['x-csrf-token'] !== 'stub-csrf') {
                return send(req, res, 403, { error: 'csrf' });
            }
            const b = await readBody(req);
            if (!SLUG.test(b.slug ?? ''))
                return send(req, res, 400, { error: 'bad_slug' });
            if (!validPayload(b))
                return send(req, res, 400, { error: 'bad_payload' });
            if (store.shares[b.slug])
                return send(req, res, 409, { error: 'slug_taken' });
            if (b.visibility && !['private', 'shared'].includes(b.visibility))
                return send(req, res, 400, { error: 'invalid' });
            const share = {
                slug: b.slug,
                title: String(b.title || b.slug),
                visibility: b.visibility || 'shared',
                createdBy: USER,
                versions: [newVersion(b, 1)],
            };
            store.shares[b.slug] = share;
            save(store);
            return send(req, res, 201, toVersion(share, share.versions[0]));
        }

        const share = store.shares[parts[1]];
        if (!share || !visibleTo(share))
            return send(req, res, 404, { error: 'not_found' });
        const latest = share.versions[share.versions.length - 1];

        if (parts.length === 2 && req.method === 'GET') {
            return send(req, res, 200, toVersion(share, latest));
        }
        if (
            parts[2] === 'versions' &&
            parts.length === 3 &&
            req.method === 'GET'
        ) {
            return send(req, res, 200, {
                versions: [...share.versions].reverse().map((v) => ({
                    version: v.version,
                    note: v.note,
                    publishedBy: v.publishedBy,
                    publishedAt: v.publishedAt,
                    source: v.source,
                })),
            });
        }
        if (
            parts[2] === 'versions' &&
            parts.length === 4 &&
            req.method === 'GET'
        ) {
            const v = share.versions.find(
                (x) => x.version === Number(parts[3])
            );
            return v
                ? send(req, res, 200, toVersion(share, v))
                : send(req, res, 404, { error: 'not_found' });
        }
        if (
            parts[2] === 'visibility' &&
            parts.length === 3 &&
            req.method === 'POST'
        ) {
            const b = await readBody(req);
            if (b.visibility !== 'shared')
                return send(req, res, 400, { error: 'invalid' });
            if ((share.createdBy ?? USER) !== USER)
                return send(req, res, 403, { error: 'forbidden' });
            share.visibility = 'shared';
            save(store);
            return send(req, res, 200, {
                slug: share.slug,
                visibility: 'shared',
            });
        }
        if (
            parts[2] === 'versions' &&
            parts.length === 3 &&
            req.method === 'POST'
        ) {
            if (req.headers['x-csrf-token'] !== 'stub-csrf') {
                return send(req, res, 403, { error: 'csrf' });
            }
            const b = await readBody(req);
            if (!validPayload(b))
                return send(req, res, 400, { error: 'bad_payload' });
            if (!b.force && Number(b.baseVersion) < latest.version) {
                return send(req, res, 409, {
                    error: 'stale_base',
                    latestVersion: latest.version,
                    publishedBy: latest.publishedBy,
                    publishedAt: latest.publishedAt,
                });
            }
            const v = newVersion(b, latest.version + 1);
            share.versions.push(v);
            save(store);
            return send(req, res, 201, toVersion(share, v));
        }
        return send(req, res, 404, { error: 'not_found' });
    } catch (e) {
        return send(req, res, 500, { error: 'internal', message: String(e) });
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`dbd stub API on http://127.0.0.1:${PORT}/api as ${USER}`);
});
