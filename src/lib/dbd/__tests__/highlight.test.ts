import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import { diffDiagrams } from '@/lib/dbd/diff';
import { buildHighlights } from '@/lib/dbd/highlight';

const load = (dbml: string) =>
    importDBMLToDiagram(dbml, { databaseType: DatabaseType.POSTGRESQL });

const BASE = `
Table users {
  id uuid [pk]
  email varchar(100)
}
Table orders {
  id text [pk]
  amount numeric(20,2)
}
Table audit {
  id bigint [pk]
}
`;

describe('buildHighlights', () => {
    it('marks local tables and fields by side, and lists their new tables', async () => {
        const base = await load(BASE);
        // mine: change users.email, add orders.note
        const mine = await load(
            BASE.replace('email varchar(100)', 'email text').replace(
                'amount numeric(20,2)',
                'amount numeric(20,2)\n  note text'
            )
        );
        // theirs: add users.phone, add table payments
        const theirs = await load(
            BASE.replace(
                'email varchar(100)',
                'email varchar(100)\n  phone text'
            ) + '\nTable payments {\n  id text [pk]\n}\n'
        );

        const h = buildHighlights({
            diagram: mine,
            mine: diffDiagrams(base, mine),
            theirs: diffDiagrams(base, theirs),
            baseVersion: 3,
            latestVersion: 4,
        });

        const byName = (name: string) =>
            mine.tables!.find((t) => t.name === name)!;
        const users = byName('users');
        const orders = byName('orders');

        expect(h.tables.get(users.id)?.side).toBe('both');
        expect(h.tables.get(orders.id)?.side).toBe('mine');
        expect(h.tables.has(byName('audit').id)).toBe(false);
        expect(h.tables.get(users.id)?.lines).toEqual([
            'mine: ~ email: varchar(100) → text',
            'theirs: + phone',
        ]);

        const email = users.fields.find((f) => f.name === 'email')!;
        const note = orders.fields.find((f) => f.name === 'note')!;
        expect(h.fields.get(email.id)).toEqual({
            side: 'mine',
            kind: 'changed',
        });
        expect(h.fields.get(note.id)).toEqual({ side: 'mine', kind: 'added' });

        expect(h.missing).toEqual(['payments']);
    });
});
