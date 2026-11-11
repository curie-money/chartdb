import React from 'react';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/tooltip/tooltip';
import { cn } from '@/lib/utils';
import { SIDE_STYLES, type TableMark } from '@/lib/dbd/highlight';

// Curie dbd: label above a table changed since the shared version you took.
export const TableNodeDbdBadge: React.FC<{ mark: TableMark }> = ({ mark }) => {
    const style = SIDE_STYLES[mark.side];
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div
                    className={cn(
                        'absolute -top-8 left-0 z-10 max-w-full truncate rounded px-2 py-0.5 text-xs font-semibold shadow',
                        style.badge
                    )}
                >
                    {style.label} · {mark.lines.length}
                </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
                <ul className="font-mono text-xs">
                    {mark.lines.map((line, i) => (
                        <li key={i}>{line}</li>
                    ))}
                </ul>
            </TooltipContent>
        </Tooltip>
    );
};
