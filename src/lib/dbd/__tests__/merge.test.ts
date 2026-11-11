import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import { diffDiagrams, isEmptyDiff } from '@/lib/dbd/diff';
import { mergeDiagrams } from '@/lib/dbd/merge';
import type { Diagram } from '@/lib/domain/diagram';

const load = (dbml: string) =>
    importDBMLToDiagram(dbml, { databaseType: DatabaseType.POSTGRESQL });

const BASE = `
Table handles {
  id text [pk]
  vpa varchar(255)
}
Table numbers {
  id text [pk]
  handle_id text
}
Table audit {
  id bigint [pk]
}
TableGroup identity {
  handles
  numbers
}
`;

const fields = (d: Diagram, table: string) =>
    d.tables!.find((t) => t.name === table)?.fields.map((f) => f.name);

describe('mergeDiagrams', () => {
    it('combines changes to different tables without asking (the lost-column case)', async () => {
        const base = await load(BASE);
        const theirs = await load(
            BASE.replace(
                'vpa varchar(255)',
                'vpa varchar(255)\n  verified_at timestamptz'
            )
        );
        const mine = await load(
            BASE.replace(
                'handle_id text',
                'handle_id text\n  is_default boolean'
            )
        );

        const r = mergeDiagrams(base, mine, theirs);
        expect(r.conflicts).toEqual([]);
        expect(fields(r.diagram, 'handles')).toEqual([
            'id',
            'vpa',
            'verified_at',
        ]);
        expect(fields(r.diagram, 'numbers')).toEqual([
            'id',
            'handle_id',
            'is_default',
        ]);
        expect(r.applied).toEqual(['+ handles.verified_at']);

        // Relative to their version, only my change remains.
        const mineVsTheirs = diffDiagrams(theirs, r.diagram);
        expect(mineVsTheirs.tablesChanged.map((c) => c.table)).toEqual([
            'numbers',
        ]);
    });

    it('applies their removals of things I did not touch', async () => {
        const base = await load(BASE);
        const theirs = await load(
            BASE.replace('Table audit {\n  id bigint [pk]\n}', '')
        );
        const mine = await load(BASE.replace('vpa varchar(255)', 'vpa text'));
        const r = mergeDiagrams(base, mine, theirs);
        expect(r.conflicts).toEqual([]);
        expect(r.diagram.tables!.map((t) => t.name).sort()).toEqual([
            'handles',
            'numbers',
        ]);
        expect(fields(r.diagram, 'handles')).toEqual(['id', 'vpa']);
        expect(
            r.diagram.tables!.find((t) => t.name === 'handles')!.fields[1].type
                .name
        ).toBe('text');
    });

    it('asks when both changed the same column, and honours the answer', async () => {
        const base = await load(BASE);
        const theirs = await load(
            BASE.replace('vpa varchar(255)', 'vpa varchar(100)')
        );
        const mine = await load(BASE.replace('vpa varchar(255)', 'vpa text'));

        const asked = mergeDiagrams(base, mine, theirs);
        expect(asked.conflicts).toEqual([
            {
                key: 'handles.vpa',
                table: 'handles',
                field: 'vpa',
                mine: 'text',
                theirs: 'varchar(100)',
            },
        ]);
        expect(asked.unresolved).toHaveLength(1);
        // Unresolved keeps mine.
        expect(
            asked.diagram.tables!.find((t) => t.name === 'handles')!.fields[1]
                .type.name
        ).toBe('text');

        const theirsWins = mergeDiagrams(base, mine, theirs, {
            'handles.vpa': 'theirs',
        });
        const vpa = theirsWins.diagram.tables!.find(
            (t) => t.name === 'handles'
        )!.fields[1];
        expect(vpa.type.name).toBe('varchar');
        expect(vpa.characterMaximumLength).toBe('100');
        expect(theirsWins.unresolved).toEqual([]);
    });

    it('does not ask when both made the same change', async () => {
        const base = await load(BASE);
        const changed = BASE.replace('vpa varchar(255)', 'vpa text');
        const r = mergeDiagrams(base, await load(changed), await load(changed));
        expect(r.conflicts).toEqual([]);
        expect(r.applied).toEqual([]);
    });

    it('asks when they removed a table I changed, and when I removed one they changed', async () => {
        const base = await load(BASE);
        const noAudit = BASE.replace('Table audit {\n  id bigint [pk]\n}', '');
        const auditChanged = BASE.replace(
            'id bigint [pk]\n}',
            'id bigint [pk]\n  at timestamptz\n}'
        );

        const theyRemoved = mergeDiagrams(
            base,
            await load(auditChanged),
            await load(noAudit)
        );
        expect(
            theyRemoved.conflicts.map((c) => [c.key, c.mine, c.theirs])
        ).toEqual([['audit', 'changed by you', 'removed']]);
        expect(fields(theyRemoved.diagram, 'audit')).toEqual(['id', 'at']);
        const removed = mergeDiagrams(
            base,
            await load(auditChanged),
            await load(noAudit),
            { audit: 'theirs' }
        );
        expect(fields(removed.diagram, 'audit')).toBeUndefined();

        const iRemoved = mergeDiagrams(
            base,
            await load(noAudit),
            await load(auditChanged),
            { audit: 'theirs' }
        );
        expect(
            iRemoved.conflicts.map((c) => [c.key, c.mine, c.theirs])
        ).toEqual([['audit', 'removed', 'changed by them']]);
        expect(fields(iRemoved.diagram, 'audit')).toEqual(['id', 'at']);
    });

    it('brings in their new table with its relationship and group placement', async () => {
        const base = await load(BASE);
        const theirs = await load(
            BASE.replace(
                'TableGroup identity {',
                'Table disputes {\n  id text [pk]\n  handle_id text [ref: > handles.id]\n}\nTableGroup identity {\n  disputes'
            )
        );
        const mine = await load(
            BASE.replace(
                'handle_id text',
                'handle_id text\n  is_default boolean'
            )
        );
        const r = mergeDiagrams(base, mine, theirs);

        expect(r.conflicts).toEqual([]);
        expect(r.applied).toEqual([
            '+ table disputes',
            '+ relationship handles.id → disputes.handle_id (one:many)',
        ]);
        const disputes = r.diagram.tables!.find((t) => t.name === 'disputes')!;
        const identity = r.diagram.areas!.find((a) => a.name === 'identity')!;
        expect(disputes.parentAreaId).toBe(identity.id);
        expect(disputes.x).toBeGreaterThanOrEqual(identity.x);

        // Everything they did is now in my copy; nothing of mine was lost.
        const missingFromMerge = diffDiagrams(theirs, r.diagram);
        expect(missingFromMerge.tablesAdded).toEqual([]);
        expect(missingFromMerge.tablesRemoved).toEqual([]);
        expect(missingFromMerge.relationshipsRemoved).toEqual([]);
        expect(missingFromMerge.tablesChanged.map((c) => c.table)).toEqual([
            'numbers',
        ]);
    });

    it('drops relationships they removed and ones left dangling', async () => {
        const withRef = BASE.replace(
            'handle_id text',
            'handle_id text [ref: > handles.id]'
        );
        const base = await load(withRef);
        const theirs = await load(BASE); // ref removed
        const mine = await load(
            withRef.replace(
                'Table audit {',
                'Table audit2 {\n  id int\n}\nTable audit {'
            )
        );
        const r = mergeDiagrams(base, mine, theirs);
        expect(r.applied).toContain(
            '− relationship handles.id → numbers.handle_id (one:many)'
        );
        expect(r.diagram.relationships).toEqual([]);
        expect(
            isEmptyDiff(
                diffDiagrams(theirs, {
                    ...r.diagram,
                    tables: r.diagram.tables!.filter(
                        (t) => t.name !== 'audit2'
                    ),
                })
            )
        ).toBe(true);
    });

    it('does not modify its inputs', async () => {
        const base = await load(BASE);
        const theirs = await load(
            BASE.replace(
                'vpa varchar(255)',
                'vpa varchar(255)\n  verified_at timestamptz'
            )
        );
        const mine = await load(BASE);
        const before = JSON.stringify(mine);
        mergeDiagrams(base, mine, theirs);
        expect(JSON.stringify(mine)).toBe(before);
    });
});
