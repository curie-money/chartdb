// Canvas highlighting for "what changed since the version I took".
// Display-only: marks live in this module, never in the diagram, so nothing
// here is saved to IndexedDB or published.

import { useSyncExternalStore } from 'react';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DiagramDiff } from './diff';

export type ChangeSide = 'mine' | 'theirs' | 'both';

export interface TableMark {
    side: ChangeSide;
    lines: string[]; // e.g. "theirs: + verified_at"
}

export interface FieldMark {
    side: ChangeSide;
    kind: 'added' | 'changed';
}

export interface Highlights {
    tables: Map<string, TableMark>; // by local table id
    fields: Map<string, FieldMark>; // by local field id
    missing: string[]; // tables they added that your copy does not have
    baseVersion: number;
    latestVersion: number | null;
}

let current: Highlights | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

export const setHighlights = (h: Highlights | null) => {
    current = h;
    emit();
};

export const clearHighlights = () => setHighlights(null);

export const useHighlights = (): Highlights | null =>
    useSyncExternalStore(subscribe, () => current);

export const useTableMark = (tableId: string): TableMark | undefined =>
    useSyncExternalStore(subscribe, () => current?.tables.get(tableId));

export const useFieldMark = (fieldId: string): FieldMark | undefined =>
    useSyncExternalStore(subscribe, () => current?.fields.get(fieldId));

// Must match diff.ts tableKey.
const tableKey = (t: Pick<DBTable, 'schema' | 'name'>) =>
    t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name;

const merge = (a: ChangeSide | undefined, b: ChangeSide): ChangeSide =>
    !a || a === b ? b : 'both';

export const buildHighlights = ({
    diagram,
    mine,
    theirs,
    baseVersion,
    latestVersion,
}: {
    diagram: Diagram;
    mine: DiagramDiff | null;
    theirs: DiagramDiff | null;
    baseVersion: number;
    latestVersion: number | null;
}): Highlights => {
    const byKey = new Map((diagram.tables ?? []).map((t) => [tableKey(t), t]));
    const tables = new Map<string, TableMark>();
    const fields = new Map<string, FieldMark>();
    const missing: string[] = [];

    const markTable = (key: string, side: ChangeSide, line: string) => {
        const table = byKey.get(key);
        if (!table) return false;
        const prev = tables.get(table.id);
        tables.set(table.id, {
            side: merge(prev?.side, side),
            lines: [...(prev?.lines ?? []), `${side}: ${line}`],
        });
        return true;
    };
    const markField = (
        key: string,
        fieldName: string,
        side: ChangeSide,
        kind: FieldMark['kind']
    ) => {
        const field = byKey.get(key)?.fields.find((f) => f.name === fieldName);
        if (!field) return;
        const prev = fields.get(field.id);
        fields.set(field.id, { side: merge(prev?.side, side), kind });
    };

    const apply = (diff: DiagramDiff | null, side: 'mine' | 'theirs') => {
        if (!diff) return;
        for (const t of diff.tablesAdded) {
            if (!markTable(t, side, 'new table') && side === 'theirs') {
                missing.push(t);
            }
        }
        for (const t of diff.tablesRemoved) {
            markTable(t, side, 'removed this table');
        }
        for (const c of diff.tablesChanged) {
            c.fieldsAdded.forEach((f) => {
                markTable(c.table, side, `+ ${f}`);
                markField(c.table, f, side, 'added');
            });
            c.fieldsRemoved.forEach((f) => markTable(c.table, side, `− ${f}`));
            c.fieldsChanged.forEach((f) => {
                markTable(c.table, side, `~ ${f.field}: ${f.from} → ${f.to}`);
                markField(c.table, f.field, side, 'changed');
            });
        }
        for (const m of diff.groupMoves) {
            markTable(
                m.table,
                side,
                `group ${m.from ?? '(none)'} → ${m.to ?? '(none)'}`
            );
        }
    };

    apply(mine, 'mine');
    apply(theirs, 'theirs');
    return {
        tables,
        fields,
        missing: missing.sort(),
        baseVersion,
        latestVersion,
    };
};

export const SIDE_STYLES: Record<
    ChangeSide,
    { outline: string; badge: string; row: string; label: string }
> = {
    mine: {
        outline:
            'outline outline-[3px] outline-violet-500 outline-offset-[5px]',
        badge: 'bg-violet-600 text-white',
        row: 'bg-violet-100 dark:bg-violet-950',
        label: 'Your change',
    },
    theirs: {
        outline: 'outline outline-[3px] outline-amber-500 outline-offset-[5px]',
        badge: 'bg-amber-500 text-black',
        row: 'bg-amber-100 dark:bg-amber-950',
        label: 'Their change',
    },
    both: {
        outline: 'outline outline-[4px] outline-rose-600 outline-offset-[5px]',
        badge: 'bg-rose-600 text-white',
        row: 'bg-rose-100 dark:bg-rose-950',
        label: 'Both changed',
    },
};
