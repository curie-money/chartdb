import React from 'react';
import type { DiagramDiff } from '@/lib/dbd/diff';
import { isEmptyDiff } from '@/lib/dbd/diff';
import { cn } from '@/lib/utils';

export interface DiagramDiffViewProps {
    title: string;
    diff: DiagramDiff;
    // Tables the other side also changed; flagged so they stand out.
    overlap?: Set<string>;
}

const Row: React.FC<{
    kind: 'add' | 'remove' | 'change';
    children: React.ReactNode;
    flagged?: boolean;
}> = ({ kind, children, flagged }) => (
    <li
        className={cn(
            'flex gap-1.5 rounded px-1.5 py-0.5',
            kind === 'add' && 'text-green-700 dark:text-green-400',
            kind === 'remove' && 'text-red-700 dark:text-red-400',
            kind === 'change' && 'text-amber-700 dark:text-amber-400',
            flagged && 'bg-amber-100 font-medium dark:bg-amber-950'
        )}
    >
        <span className="w-3 shrink-0 font-mono">
            {kind === 'add' ? '+' : kind === 'remove' ? '−' : '~'}
        </span>
        <span className="min-w-0 break-words">{children}</span>
    </li>
);

export const DiagramDiffView: React.FC<DiagramDiffViewProps> = ({
    title,
    diff,
    overlap,
}) => {
    const flag = (table: string) => overlap?.has(table) ?? false;
    return (
        <div className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                {title}
            </h4>
            {isEmptyDiff(diff) ? (
                <p className="text-xs text-muted-foreground">No changes.</p>
            ) : (
                <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto font-mono text-xs">
                    {diff.tablesAdded.map((t) => (
                        <Row key={`ta-${t}`} kind="add" flagged={flag(t)}>
                            table {t}
                        </Row>
                    ))}
                    {diff.tablesRemoved.map((t) => (
                        <Row key={`tr-${t}`} kind="remove" flagged={flag(t)}>
                            table {t}
                        </Row>
                    ))}
                    {diff.tablesChanged.map((c) => (
                        <React.Fragment key={`tc-${c.table}`}>
                            {c.fieldsAdded.map((f) => (
                                <Row
                                    key={`fa-${c.table}-${f}`}
                                    kind="add"
                                    flagged={flag(c.table)}
                                >
                                    {c.table}.{f}
                                </Row>
                            ))}
                            {c.fieldsRemoved.map((f) => (
                                <Row
                                    key={`fr-${c.table}-${f}`}
                                    kind="remove"
                                    flagged={flag(c.table)}
                                >
                                    {c.table}.{f}
                                </Row>
                            ))}
                            {c.fieldsChanged.map((f) => (
                                <Row
                                    key={`fc-${c.table}-${f.field}`}
                                    kind="change"
                                    flagged={flag(c.table)}
                                >
                                    {c.table}.{f.field}: {f.from} → {f.to}
                                </Row>
                            ))}
                        </React.Fragment>
                    ))}
                    {diff.relationshipsAdded.map((r) => (
                        <Row key={`ra-${r}`} kind="add">
                            ref {r}
                        </Row>
                    ))}
                    {diff.relationshipsRemoved.map((r) => (
                        <Row key={`rr-${r}`} kind="remove">
                            ref {r}
                        </Row>
                    ))}
                    {diff.groupsAdded.map((g) => (
                        <Row key={`ga-${g}`} kind="add">
                            group {g}
                        </Row>
                    ))}
                    {diff.groupsRemoved.map((g) => (
                        <Row key={`gr-${g}`} kind="remove">
                            group {g}
                        </Row>
                    ))}
                    {diff.groupMoves.map((m) => (
                        <Row
                            key={`gm-${m.table}`}
                            kind="change"
                            flagged={flag(m.table)}
                        >
                            {m.table}: group {m.from ?? '(none)'} →{' '}
                            {m.to ?? '(none)'}
                        </Row>
                    ))}
                </ul>
            )}
        </div>
    );
};
