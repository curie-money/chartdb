import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/button/button';
import { useChartDB } from '@/hooks/use-chartdb';
import { DiagramDiffView } from '@/dialogs/share-dialog/diagram-diff-view';
import { shareUrl } from '@/lib/dbd/payload';
import {
    clearUpdateNotice,
    getUpdateNotice,
    removals,
    type UpdateNotice,
} from '@/lib/dbd/update-notice';

// Curie dbd: shown after a shared link moved this copy to a newer version
// without asking (the copy had no unpublished edits). Says what the new
// version changed, and calls out anything it removed from what you had.
export const DbdUpdateNotice: React.FC = () => {
    const { currentDiagram } = useChartDB();
    const [notice, setNotice] = useState<UpdateNotice | null>(null);

    useEffect(() => {
        setNotice(getUpdateNotice(currentDiagram.id));
    }, [currentDiagram.id]);

    if (!notice) return null;

    const dismiss = () => {
        clearUpdateNotice(currentDiagram.id);
        setNotice(null);
    };
    const removed = removals(notice.diff);

    return (
        <div
            role="status"
            className="fixed right-4 top-16 z-50 flex max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto rounded-lg border bg-background p-3 text-xs shadow-lg"
        >
            <div className="flex items-start justify-between gap-2">
                <p className="text-sm">
                    Updated to version <b>{notice.toVersion}</b> (you had
                    version {notice.fromVersion}).{' '}
                    <span className="text-muted-foreground">
                        Published by {notice.publishedBy} on{' '}
                        {new Date(notice.publishedAt).toLocaleString()}
                        {notice.note ? `: "${notice.note}"` : '.'}
                    </span>
                </p>
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    title="Dismiss"
                    onClick={dismiss}
                >
                    <X className="size-4" />
                </Button>
            </div>
            {removed.length > 0 ? (
                <div className="rounded-md border border-red-300 bg-red-50 p-2 dark:border-red-800 dark:bg-red-950/40">
                    <p className="font-medium text-red-800 dark:text-red-300">
                        This version no longer has:
                    </p>
                    <ul className="mt-1 font-mono">
                        {removed.map((r) => (
                            <li key={r}>− {r}</li>
                        ))}
                    </ul>
                    <p className="mt-1">
                        If that was not intended, open version{' '}
                        {notice.fromVersion}, then add it back and publish.
                    </p>
                </div>
            ) : null}
            <DiagramDiffView
                title={`What changed (v${notice.fromVersion} → v${notice.toVersion})`}
                diff={notice.diff}
            />
            <button
                type="button"
                className="self-start underline"
                onClick={() =>
                    window.open(
                        shareUrl(notice.slug, notice.fromVersion),
                        '_blank'
                    )
                }
            >
                Open version {notice.fromVersion} as a separate copy
            </button>
        </div>
    );
};
