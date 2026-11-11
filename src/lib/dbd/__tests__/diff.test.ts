import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import { diffDiagrams, isEmptyDiff, overlappingTables } from '@/lib/dbd/diff';

const load = (dbml: string) =>
    importDBMLToDiagram(dbml, { databaseType: DatabaseType.POSTGRESQL });

const BASE = `
Table users {
  id uuid [pk]
  email varchar(100)
}
Table orders {
  id text [pk]
  user_id uuid [ref: > users.id]
}
TableGroup core { users
  orders }
`;

describe('diffDiagrams', () => {
    it('is empty for the same schema imported twice (ids differ)', async () => {
        expect(
            isEmptyDiff(diffDiagrams(await load(BASE), await load(BASE)))
        ).toBe(true);
    });

    it('reports tables, columns, types, refs and groups by name', async () => {
        const base = await load(BASE);
        const theirs = await load(`
Table users {
  id uuid [pk]
  email varchar(255)
  phone varchar
}
Table orders {
  id text [pk]
  user_id uuid
}
Table payments {
  id text [pk]
}
TableGroup core { users }
TableGroup money { orders
  payments }
`);
        const d = diffDiagrams(base, theirs);
        expect(d.tablesAdded).toEqual(['payments']);
        expect(d.tablesRemoved).toEqual([]);
        expect(d.tablesChanged).toEqual([
            {
                table: 'users',
                fieldsAdded: ['phone'],
                fieldsRemoved: [],
                fieldsChanged: [
                    {
                        field: 'email',
                        from: 'varchar(100)',
                        to: 'varchar(255)',
                    },
                ],
            },
        ]);
        expect(d.relationshipsRemoved).toHaveLength(1);
        // ChartDB stores a relationship from its "one" side.
        expect(d.relationshipsRemoved[0]).toBe(
            'users.id → orders.user_id (one:many)'
        );
        expect(d.groupsAdded).toEqual(['money']);
        expect(d.groupMoves).toEqual([
            { table: 'orders', from: 'core', to: 'money' },
        ]);
    });

    it('flags tables changed on both sides', async () => {
        const base = await load(BASE);
        const mine = await load(
            BASE.replace('email varchar(100)', 'email text')
        );
        const theirs = await load(
            BASE.replace(
                'email varchar(100)',
                'email varchar(100)\n  phone text'
            )
        );
        expect(
            overlappingTables(
                diffDiagrams(base, mine),
                diffDiagrams(base, theirs)
            )
        ).toEqual(['users']);
    });
});
