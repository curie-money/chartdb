import { DBD_API_BASE } from '@/lib/env';

export type ShareFormat = 'chartdb' | 'dbml';

export interface ShareVersion {
    slug: string;
    title: string;
    version: number;
    format: ShareFormat;
    diagram: unknown | null;
    dbml: string;
    databaseType: string;
    note: string;
    publishedBy: string;
    publishedAt: string;
    source: 'ui' | 'mcp';
}

export interface DbdSession {
    user: { email: string; name: string };
    canPublish: boolean;
    csrfToken?: string;
}

export interface PublishPayload {
    format: ShareFormat;
    diagram: unknown | null;
    dbml: string;
    databaseType: string;
    note: string;
}

export interface StaleBaseConflict {
    error: 'stale_base';
    latestVersion: number;
    publishedBy: string;
    publishedAt: string;
}

export class DbdApiError extends Error {
    constructor(
        readonly status: number,
        readonly body: Record<string, unknown> | null,
        message: string
    ) {
        super(message);
    }

    get staleBase(): StaleBaseConflict | null {
        return this.status === 409 && this.body?.error === 'stale_base'
            ? (this.body as unknown as StaleBaseConflict)
            : null;
    }

    get slugTaken(): boolean {
        return this.status === 409 && this.body?.error === 'slug_taken';
    }
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const toSlug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63) || 'diagram';

let csrfToken: string | undefined;

const request = async <T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (method === 'POST' && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
    }

    const res = await fetch(`${DBD_API_BASE}${path}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }

    if (!res.ok) {
        const message =
            (parsed?.message as string | undefined) ??
            (parsed?.error as string | undefined) ??
            `${res.status} ${res.statusText}`;
        throw new DbdApiError(res.status, parsed, message);
    }
    return parsed as T;
};

const enc = encodeURIComponent;

export const dbdApi = {
    async session(): Promise<DbdSession> {
        const session = await request<DbdSession>('GET', '/session');
        csrfToken = session.csrfToken;
        return session;
    },

    getLatest: (slug: string) =>
        request<ShareVersion>('GET', `/shares/${enc(slug)}`),

    getVersion: (slug: string, version: number) =>
        request<ShareVersion>(
            'GET',
            `/shares/${enc(slug)}/versions/${version}`
        ),

    createShare: (params: { slug: string; title: string } & PublishPayload) =>
        request<ShareVersion>('POST', '/shares', params),

    publishVersion: (
        slug: string,
        params: { baseVersion: number; force: boolean } & PublishPayload
    ) => request<ShareVersion>('POST', `/shares/${enc(slug)}/versions`, params),
};
