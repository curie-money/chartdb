import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import { generateDBMLFromDiagram } from '@/lib/dbml/dbml-export/dbml-export';
import { extractTableGroups } from '@/lib/dbml/dbml-table-groups';
import { isTableInsideArea } from '@/lib/utils/area-utils';
import type { Diagram } from '@/lib/domain/diagram';

const DBML = `
Table users {
  id uuid [pk]
  email varchar
}

Table accounts {
  id text [pk]
  user_id uuid [ref: > users.id]
}

Table payments {
  id text [pk]
  account_id text [ref: > accounts.id]
}

Table payment_events {
  id text [pk]
  payment_id text [ref: > payments.id]
}

Table audit_log {
  id bigint [pk]
}

TableGroup identity [color: #ff6363] {
  users
  accounts
  Note: 'who the user is'
}

TableGroup "money movement" {
  public.payments
  "payment_events" // trailing comment
}
`;

const membership = (diagram: Diagram) => {
    const areas = diagram.areas ?? [];
    const result: Record<string, string[]> = {};
    for (const area of areas) {
        result[area.name] = (diagram.tables ?? [])
            .filter((t) => t.parentAreaId === area.id)
            .map((t) => t.name)
            .sort();
    }
    return result;
};

describe('DBML TableGroup <-> area', () => {
    it('parses names, colors, quoted and schema-qualified members', () => {
        expect(extractTableGroups(DBML)).toEqual([
            {
                name: 'identity',
                color: '#ff6363',
                tables: [{ name: 'users' }, { name: 'accounts' }],
            },
            {
                name: 'money movement',
                color: undefined,
                tables: [
                    { schema: 'public', name: 'payments' },
                    { name: 'payment_events' },
                ],
            },
        ]);
    });

    it('imports each TableGroup as an area that contains its tables', async () => {
        const diagram = await importDBMLToDiagram(DBML, {
            databaseType: DatabaseType.POSTGRESQL,
        });

        expect(diagram.areas).toHaveLength(2);
        expect(diagram.areas?.[0].color).toBe('#ff6363');
        expect(membership(diagram)).toEqual({
            identity: ['accounts', 'users'],
            'money movement': ['payment_events', 'payments'],
        });

        const areas = diagram.areas ?? [];
        for (const table of diagram.tables ?? []) {
            const area = areas.find((a) => a.id === table.parentAreaId);
            if (area) {
                expect(isTableInsideArea(table, area)).toBe(true);
            } else {
                // ungrouped table sits outside every area
                expect(areas.some((a) => isTableInsideArea(table, a))).toBe(
                    false
                );
            }
        }
        expect(
            diagram.tables?.find((t) => t.name === 'audit_log')?.parentAreaId
        ).toBeNull();
    });

    it('exports areas as TableGroups and survives a round trip', async () => {
        const imported = await importDBMLToDiagram(DBML, {
            databaseType: DatabaseType.POSTGRESQL,
        });
        const { standardDbml, error } = generateDBMLFromDiagram(imported);
        expect(error).toBeUndefined();
        expect(standardDbml).toContain(
            'TableGroup "identity" [color: #ff6363]'
        );
        expect(standardDbml).toContain('TableGroup "money movement"');

        const again = await importDBMLToDiagram(standardDbml, {
            databaseType: DatabaseType.POSTGRESQL,
        });
        expect(membership(again)).toEqual(membership(imported));
    });

    it('leaves a DBML without groups exactly as stock ChartDB does', async () => {
        const plain = DBML.replace(/TableGroup[\s\S]*$/, '');
        const diagram = await importDBMLToDiagram(plain, {
            databaseType: DatabaseType.POSTGRESQL,
        });
        expect(diagram.areas ?? []).toHaveLength(0);
        expect(diagram.tables).toHaveLength(5);
    });
});
