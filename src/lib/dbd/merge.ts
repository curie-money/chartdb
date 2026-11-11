// Curie dbd: three-way merge of a shared diagram, by name.
//
// base   = the version this copy was taken from
// mine   = this browser's copy (base + my edits)
// theirs = the latest published version (base + their edits)
//
// The result is my copy with their changes applied. A change only one side
// made is applied (or kept) automatically; when both sides changed the same
// table or column differently, that is a conflict the person resolves as
// "keep mine" or "take theirs". Matching is by table and column name, like the
// diff, because ids are regenerated on every import.
//
// Covered: tables, columns, relationships, groups (areas) and which group a
// table sits in. Not merged: indexes and check constraints of tables both
// sides kept (mine win), notes, custom types, dependencies.

import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBField } from '@/lib/domain/db-field';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { Area } from '@/lib/domain/area';
import { generateId } from '@/lib/utils';
import { findContainingArea } from '@/lib/utils/area-utils';
import { describeField, tableKey } from './diff';

export type Resolution = 'mine' | 'theirs';

export interface MergeConflict {
    /** Stable id for the resolution map: "table" or "table.column". */
    key: string;
    table: string;
    field?: string;
    /** What my copy has, in words ("removed" when gone). */
    mine: string;
    /** What their version has. */
    theirs: string;
}

export interface MergeResult {
    diagram: Diagram;
    /** Every conflict found, whether or not a resolution was given. */
    conflicts: MergeConflict[];
    /** Conflicts with no resolution; their side defaulted to mine. */
    unresolved: MergeConflict[];
    /** Human-readable list of what was taken from theirs. */
    applied: string[];
}

const fieldPrint = (f?: DBField) => (f ? describeField(f) : undefined);

const tablePrint = (t?: DBTable) =>
    t
        ? t.fields
              .map((f) => `${f.name} ${describeField(f)}`)
              .sort()
              .join('\n')
        : undefined;

const byKey = (d: Diagram) =>
    new Map((d.tables ?? []).map((t) => [tableKey(t), t]));

interface RelInfo {
    key: string;
    rel: DBRelationship;
    source: string;
    sourceField: string;
    target: string;
    targetField: string;
}

const relationships = (d: Diagram): Map<string, RelInfo> => {
    const tables = new Map((d.tables ?? []).map((t) => [t.id, t]));
    const out = new Map<string, RelInfo>();
    for (const r of d.relationships ?? []) {
        const s = tables.get(r.sourceTableId);
        const t = tables.get(r.targetTableId);
        const sf = s?.fields.find((f) => f.id === r.sourceFieldId);
        const tf = t?.fields.find((f) => f.id === r.targetFieldId);
        if (!s || !t || !sf || !tf) continue;
        const key = `${tableKey(s)}.${sf.name} → ${tableKey(t)}.${tf.name} (${r.sourceCardinality}:${r.targetCardinality})`;
        out.set(key, {
            key,
            rel: r,
            source: tableKey(s),
            sourceField: sf.name,
            target: tableKey(t),
            targetField: tf.name,
        });
    }
    return out;
};

const areaOf = (d: Diagram, table: DBTable): Area | undefined => {
    const areas = d.areas ?? [];
    return (
        findContainingArea(table, areas) ??
        (table.parentAreaId
            ? areas.find((a) => a.id === table.parentAreaId)
            : undefined)
    );
};

const cloneField = (f: DBField): DBField => ({ ...f, id: generateId() });

const cloneTable = (t: DBTable): DBTable => {
    const ids = new Map<string, string>();
    const fields = t.fields.map((f) => {
        const c = cloneField(f);
        ids.set(f.id, c.id);
        return c;
    });
    return {
        ...t,
        id: generateId(),
        fields,
        indexes: (t.indexes ?? []).map((i) => ({
            ...i,
            id: generateId(),
            fieldIds: i.fieldIds.map((id) => ids.get(id) ?? id),
        })),
        checkConstraints: (t.checkConstraints ?? null)?.map((c) => ({
            ...c,
            id: generateId(),
        })),
        parentAreaId: null,
    };
};

const cloneDeep = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const mergeDiagrams = (
    base: Diagram,
    mine: Diagram,
    theirs: Diagram,
    resolutions: Record<string, Resolution> = {}
): MergeResult => {
    // Work on a copy of mine; Dates survive as the originals below.
    const merged: Diagram = {
        ...mine,
        tables: cloneDeep(mine.tables ?? []),
        relationships: cloneDeep(mine.relationships ?? []),
        areas: cloneDeep(mine.areas ?? []),
    };
    const conflicts: MergeConflict[] = [];
    const applied: string[] = [];

    const B = byKey(base);
    const M = byKey(mine);
    const T = byKey(theirs);
    const mergedTables = () =>
        new Map(merged.tables!.map((t) => [tableKey(t), t]));

    const decide = (c: MergeConflict): Resolution => {
        conflicts.push(c);
        return resolutions[c.key] ?? 'mine';
    };

    // Places a table taken from theirs: inside the area of the same name in
    // my copy (keeping its offset within their area), else where they had it.
    const placeFromTheirs = (target: DBTable, theirsTable: DBTable) => {
        const theirArea = areaOf(theirs, theirsTable);
        const myArea = theirArea
            ? merged.areas!.find((a) => a.name === theirArea.name)
            : undefined;
        if (theirArea && myArea) {
            target.x = myArea.x + (theirsTable.x - theirArea.x);
            target.y = myArea.y + (theirsTable.y - theirArea.y);
            target.parentAreaId = myArea.id;
        } else {
            target.x = theirsTable.x;
            target.y = theirsTable.y;
            target.parentAreaId = null;
        }
    };

    // Groups first, so tables can be placed into areas they added.
    const baseAreas = new Set((base.areas ?? []).map((a) => a.name));
    const myAreas = new Set((mine.areas ?? []).map((a) => a.name));
    for (const area of theirs.areas ?? []) {
        if (!baseAreas.has(area.name) && !myAreas.has(area.name)) {
            merged.areas!.push({ ...cloneDeep(area), id: generateId() });
            applied.push(`+ group ${area.name}`);
        }
    }
    const theirAreas = new Set((theirs.areas ?? []).map((a) => a.name));
    for (const name of baseAreas) {
        if (!theirAreas.has(name) && myAreas.has(name)) {
            const gone = merged.areas!.find((a) => a.name === name);
            merged.areas = merged.areas!.filter((a) => a.name !== name);
            for (const t of merged.tables!) {
                if (gone && t.parentAreaId === gone.id) t.parentAreaId = null;
            }
            applied.push(`− group ${name}`);
        }
    }

    const keys = new Set([...B.keys(), ...M.keys(), ...T.keys()]);
    for (const key of [...keys].sort()) {
        const b = B.get(key);
        const m = M.get(key);
        const t = T.get(key);
        const bp = tablePrint(b);
        const mp = tablePrint(m);
        const tp = tablePrint(t);

        if (!b) {
            if (t && !m) {
                const added = cloneTable(t);
                placeFromTheirs(added, t);
                merged.tables!.push(added);
                applied.push(`+ table ${key}`);
            } else if (t && m && mp !== tp) {
                const r = decide({
                    key,
                    table: key,
                    mine: 'added by you with different columns',
                    theirs: 'added by them with different columns',
                });
                if (r === 'theirs') {
                    const mt = mergedTables().get(key)!;
                    mt.fields = t.fields.map(cloneField);
                    applied.push(`~ table ${key} (theirs)`);
                }
            }
            continue;
        }

        if (!t) {
            // They removed it.
            if (!m) continue;
            if (mp === bp) {
                merged.tables = merged.tables!.filter(
                    (x) => tableKey(x) !== key
                );
                applied.push(`− table ${key}`);
            } else if (
                decide({
                    key,
                    table: key,
                    mine: 'changed by you',
                    theirs: 'removed',
                }) === 'theirs'
            ) {
                merged.tables = merged.tables!.filter(
                    (x) => tableKey(x) !== key
                );
                applied.push(`− table ${key}`);
            }
            continue;
        }

        if (!m) {
            // I removed it.
            if (
                tp !== bp &&
                decide({
                    key,
                    table: key,
                    mine: 'removed',
                    theirs: 'changed by them',
                }) === 'theirs'
            ) {
                const restored = cloneTable(t);
                placeFromTheirs(restored, t);
                merged.tables!.push(restored);
                applied.push(`+ table ${key} (restored)`);
            }
            continue;
        }

        // Both kept it: merge column by column.
        const mt = mergedTables().get(key)!;
        const bf = new Map(b.fields.map((f) => [f.name, f]));
        const mf = new Map(m.fields.map((f) => [f.name, f]));
        const tf = new Map(t.fields.map((f) => [f.name, f]));
        const names = [
            ...new Set(
                [...m.fields, ...t.fields, ...b.fields].map((f) => f.name)
            ),
        ];
        for (const name of names) {
            const bv = fieldPrint(bf.get(name));
            const mv = fieldPrint(mf.get(name));
            const tv = fieldPrint(tf.get(name));
            if (tv === bv || mv === tv) continue; // they didn't change it, or same change
            let take = mv === bv;
            if (!take) {
                take =
                    decide({
                        key: `${key}.${name}`,
                        table: key,
                        field: name,
                        mine: mv ?? 'removed',
                        theirs: tv ?? 'removed',
                    }) === 'theirs';
            }
            if (!take) continue;
            const theirsField = tf.get(name);
            const idx = mt.fields.findIndex((f) => f.name === name);
            if (!theirsField) {
                if (idx >= 0) {
                    const removedId = mt.fields[idx].id;
                    mt.fields.splice(idx, 1);
                    mt.indexes = mt.indexes
                        .map((i) => ({
                            ...i,
                            fieldIds: i.fieldIds.filter(
                                (id) => id !== removedId
                            ),
                        }))
                        .filter((i) => i.fieldIds.length > 0);
                }
                applied.push(`− ${key}.${name}`);
            } else if (idx >= 0) {
                mt.fields[idx] = {
                    ...cloneDeep(theirsField),
                    id: mt.fields[idx].id,
                };
                applied.push(`~ ${key}.${name}`);
            } else {
                mt.fields.push(cloneField(cloneDeep(theirsField)));
                applied.push(`+ ${key}.${name}`);
            }
        }

        // They moved it to another group and I did not.
        const bArea = areaOf(base, b)?.name ?? null;
        const mArea = areaOf(mine, m)?.name ?? null;
        const tArea = areaOf(theirs, t)?.name ?? null;
        if (tArea !== bArea && mArea === bArea) {
            placeFromTheirs(mt, t);
            applied.push(`→ ${key} to ${tArea ?? 'no group'}`);
        }
    }

    // Relationships: add theirs, drop the ones they removed, then drop any
    // left pointing at a table or column that no longer exists.
    const bRels = relationships(base);
    const mRels = relationships(mine);
    const tRels = relationships(theirs);
    const resolveField = (table: string, field: string) => {
        const tb = mergedTables().get(table);
        const fd = tb?.fields.find((f) => f.name === field);
        return tb && fd ? { tb, fd } : null;
    };
    for (const [key, info] of tRels) {
        if (bRels.has(key) || mRels.has(key)) continue;
        const s = resolveField(info.source, info.sourceField);
        const tg = resolveField(info.target, info.targetField);
        if (!s || !tg) continue;
        merged.relationships!.push({
            ...cloneDeep(info.rel),
            id: generateId(),
            sourceTableId: s.tb.id,
            sourceFieldId: s.fd.id,
            targetTableId: tg.tb.id,
            targetFieldId: tg.fd.id,
        });
        applied.push(`+ relationship ${key}`);
    }
    const removedByThem = new Set(
        [...bRels.keys()].filter((k) => !tRels.has(k) && mRels.has(k))
    );
    if (removedByThem.size) {
        const drop = new Set(
            [...removedByThem].map((k) => mRels.get(k)!.rel.id)
        );
        merged.relationships = merged.relationships!.filter(
            (r) => !drop.has(r.id)
        );
        for (const k of removedByThem) applied.push(`− relationship ${k}`);
    }
    const live = new Map(merged.tables!.map((t) => [t.id, t]));
    merged.relationships = merged.relationships!.filter((r) => {
        const s = live.get(r.sourceTableId);
        const t = live.get(r.targetTableId);
        return (
            !!s?.fields.some((f) => f.id === r.sourceFieldId) &&
            !!t?.fields.some((f) => f.id === r.targetFieldId)
        );
    });

    return {
        diagram: merged,
        conflicts,
        unresolved: conflicts.filter((c) => !resolutions[c.key]),
        applied,
    };
};
