// Curie dbd: a one-off notice for "your copy was moved to a newer version".
//
// Opening a link to a newer version replaces a copy that has no unpublished
// edits without asking. Whatever that version changed — including anything
// it removed from what you had — would otherwise vanish from your screen
// unannounced. The shared-link page records the comparison here and the
// editor shows it until dismissed. sessionStorage: per tab, gone on close.

import type { DiagramDiff } from './diff';

export interface UpdateNotice {
    slug: string;
    fromVersion: number;
    toVersion: number;
    publishedBy: string;
    publishedAt: string;
    note: string;
    diff: DiagramDiff;
}

const key = (diagramId: string) => `dbd:notice:${diagramId}`;

export const setUpdateNotice = (diagramId: string, notice: UpdateNotice) => {
    try {
        sessionStorage.setItem(key(diagramId), JSON.stringify(notice));
    } catch {
        // Storage unavailable: the notice is a convenience, not a record.
    }
};

export const getUpdateNotice = (diagramId: string): UpdateNotice | null => {
    try {
        const raw = sessionStorage.getItem(key(diagramId));
        return raw ? (JSON.parse(raw) as UpdateNotice) : null;
    } catch {
        return null;
    }
};

export const clearUpdateNotice = (diagramId: string) => {
    try {
        sessionStorage.removeItem(key(diagramId));
    } catch {
        // ignore
    }
};

/** Things the newer version took away from the copy that was replaced. */
export const removals = (d: DiagramDiff): string[] => [
    ...d.tablesRemoved.map((t) => `table ${t}`),
    ...d.tablesChanged.flatMap((c) =>
        c.fieldsRemoved.map((f) => `${c.table}.${f}`)
    ),
    ...d.tablesChanged.flatMap((c) =>
        c.fieldsChanged.map(
            (f) => `${c.table}.${f.field} (was ${f.from}, now ${f.to})`
        )
    ),
    ...d.relationshipsRemoved.map((r) => `relationship ${r}`),
    ...d.groupsRemoved.map((g) => `group ${g}`),
];
