import React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/button/button';
import { cn } from '@/lib/utils';
import {
    clearHighlights,
    SIDE_STYLES,
    useHighlights,
    type ChangeSide,
} from '@/lib/dbd/highlight';

// Curie dbd: legend for the change highlight, shown while it is on.
export const DbdHighlightLegend: React.FC = () => {
    const highlights = useHighlights();
    if (!highlights) return null;

    const counts: Record<ChangeSide, number> = { mine: 0, theirs: 0, both: 0 };
    highlights.tables.forEach((m) => (counts[m.side] += 1));

    return (
        <div className="fixed bottom-24 right-4 z-50 flex max-w-xs flex-col gap-2 rounded-lg border bg-background p-3 text-xs shadow-lg">
            <div className="flex items-center justify-between gap-4">
                <span className="font-semibold">
                    Changes since v{highlights.baseVersion}
                    {highlights.latestVersion
                        ? ` (latest v${highlights.latestVersion})`
                        : ''}
                </span>
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title="Clear highlight"
                    onClick={clearHighlights}
                >
                    <X className="size-4" />
                </Button>
            </div>
            {(Object.keys(counts) as ChangeSide[]).map((side) => (
                <div key={side} className="flex items-center gap-2">
                    <span
                        className={cn(
                            'inline-block size-3 rounded-sm',
                            SIDE_STYLES[side].badge
                        )}
                    />
                    <span>
                        {SIDE_STYLES[side].label}: {counts[side]}{' '}
                        {counts[side] === 1 ? 'table' : 'tables'}
                    </span>
                </div>
            ))}
            {highlights.missing.length > 0 ? (
                <p className="text-muted-foreground">
                    Added by them, not in your copy:{' '}
                    <span className="font-mono">
                        {highlights.missing.join(', ')}
                    </span>
                </p>
            ) : null}
            <p className="text-muted-foreground">
                Hover a table&apos;s label for details. Nothing here is saved or
                published.
            </p>
        </div>
    );
};
