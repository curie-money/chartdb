// Structural diff between two versions of a diagram, keyed by names (ids are
// regenerated on every import, so they cannot be compared across versions).

import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBField } from '@/lib/domain/db-field';
import { findContainingArea } from '@/lib/utils/area-utils';

export interface FieldChange {
    field: string;
    from: string;
    to: string;
}

export interface TableChange {
    table: string;
    fieldsAdded: string[];
    fieldsRemoved: string[];
    fieldsChanged: FieldChange[];
}

export interface GroupMove {
    table: string;
    from: string | null;
    to: string | null;
}

export interface DiagramDiff {
    tablesAdded: string[];
    tablesRemoved: string[];
    tablesChanged: TableChange[];
    relationshipsAdded: string[];
    relationshipsRemoved: string[];
    groupsAdded: string[];
    groupsRemoved: string[];
    groupMoves: GroupMove[];
}

const tableKey = (t: Pick<DBTable, 'schema' | 'name'>) =>
    t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name;

const describeField = (f: DBField): string => {
    let type = f.type?.name ?? '?';
    if (f.characterMaximumLength) type += `(${f.characterMaximumLength})`;
    else if (f.precision != null)
        type += `(${f.precision}${f.scale != null ? `,${f.scale}` : ''})`;
    if (f.isArray) type += '[]';
    const flags = [
        f.primaryKey && 'pk',
        f.unique && !f.primaryKey && 'unique',
        !f.nullable && !f.primaryKey && 'not null',
        f.default ? `default ${f.default}` : null,
    ].filter(Boolean);
    return flags.length ? `${type} ${flags.join(', ')}` : type;
};

const relationshipKeys = (diagram: Diagram): Set<string> => {
    const tables = new Map((diagram.tables ?? []).map((t) => [t.id, t]));
    const keys = new Set<string>();
    for (const r of diagram.relationships ?? []) {
        const s = tables.get(r.sourceTableId);
        const t = tables.get(r.targetTableId);
        const sf = s?.fields.find((f) => f.id === r.sourceFieldId);
        const tf = t?.fields.find((f) => f.id === r.targetFieldId);
        if (!s || !t || !sf || !tf) continue;
        keys.add(
            `${tableKey(s)}.${sf.name} → ${tableKey(t)}.${tf.name} (${r.sourceCardinality}:${r.targetCardinality})`
        );
    }
    return keys;
};

const groupOf = (diagram: Diagram): Map<string, string | null> => {
    const areas = diagram.areas ?? [];
    const byId = new Map(areas.map((a) => [a.id, a]));
    const result = new Map<string, string | null>();
    for (const table of diagram.tables ?? []) {
        const area =
            findContainingArea(table, areas) ??
            (table.parentAreaId ? byId.get(table.parentAreaId) : undefined);
        result.set(tableKey(table), area?.name ?? null);
    }
    return result;
};

const minus = <T>(a: Set<T>, b: Set<T>) => [...a].filter((x) => !b.has(x));

export const diffDiagrams = (before: Diagram, after: Diagram): DiagramDiff => {
    const beforeTables = new Map(
        (before.tables ?? []).map((t) => [tableKey(t), t])
    );
    const afterTables = new Map(
        (after.tables ?? []).map((t) => [tableKey(t), t])
    );

    const tablesChanged: TableChange[] = [];
    for (const [key, a] of afterTables) {
        const b = beforeTables.get(key);
        if (!b) continue;
        const bf = new Map(b.fields.map((f) => [f.name, f]));
        const af = new Map(a.fields.map((f) => [f.name, f]));
        const change: TableChange = {
            table: key,
            fieldsAdded: minus(new Set(af.keys()), new Set(bf.keys())),
            fieldsRemoved: minus(new Set(bf.keys()), new Set(af.keys())),
            fieldsChanged: [],
        };
        for (const [name, field] of af) {
            const old = bf.get(name);
            if (!old) continue;
            const from = describeField(old);
            const to = describeField(field);
            if (from !== to)
                change.fieldsChanged.push({ field: name, from, to });
        }
        if (
            change.fieldsAdded.length ||
            change.fieldsRemoved.length ||
            change.fieldsChanged.length
        ) {
            tablesChanged.push(change);
        }
    }

    const beforeRels = relationshipKeys(before);
    const afterRels = relationshipKeys(after);
    const beforeGroups = groupOf(before);
    const afterGroups = groupOf(after);
    const beforeGroupNames = new Set((before.areas ?? []).map((a) => a.name));
    const afterGroupNames = new Set((after.areas ?? []).map((a) => a.name));

    const groupMoves: GroupMove[] = [];
    for (const [table, to] of afterGroups) {
        if (!beforeGroups.has(table)) continue;
        const from = beforeGroups.get(table) ?? null;
        if (from !== to) groupMoves.push({ table, from, to });
    }

    return {
        tablesAdded: minus(
            new Set(afterTables.keys()),
            new Set(beforeTables.keys())
        ).sort(),
        tablesRemoved: minus(
            new Set(beforeTables.keys()),
            new Set(afterTables.keys())
        ).sort(),
        tablesChanged: tablesChanged.sort((a, b) =>
            a.table.localeCompare(b.table)
        ),
        relationshipsAdded: minus(afterRels, beforeRels).sort(),
        relationshipsRemoved: minus(beforeRels, afterRels).sort(),
        groupsAdded: minus(afterGroupNames, beforeGroupNames).sort(),
        groupsRemoved: minus(beforeGroupNames, afterGroupNames).sort(),
        groupMoves: groupMoves.sort((a, b) => a.table.localeCompare(b.table)),
    };
};

export const isEmptyDiff = (d: DiagramDiff): boolean =>
    !d.tablesAdded.length &&
    !d.tablesRemoved.length &&
    !d.tablesChanged.length &&
    !d.relationshipsAdded.length &&
    !d.relationshipsRemoved.length &&
    !d.groupsAdded.length &&
    !d.groupsRemoved.length &&
    !d.groupMoves.length;

// Tables both sides touched since the common base: these are the ones where
// publishing yours would hide theirs.
export const touchedTables = (d: DiagramDiff): Set<string> =>
    new Set([
        ...d.tablesAdded,
        ...d.tablesRemoved,
        ...d.tablesChanged.map((c) => c.table),
        ...d.groupMoves.map((m) => m.table),
    ]);

export const overlappingTables = (
    mine: DiagramDiff,
    theirs: DiagramDiff
): string[] => {
    const t = touchedTables(theirs);
    return [...touchedTables(mine)].filter((x) => t.has(x)).sort();
};
