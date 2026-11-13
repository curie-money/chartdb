import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/button/button';
import { useChartDB } from '@/hooks/use-chartdb';
import { useStorage } from '@/hooks/use-storage';
import { dbdApi, type ShareVersionMeta } from '@/lib/dbd/api';
import { getLinkForDiagram, hasEditsSinceSync } from '@/lib/dbd/link-store';

// Curie dbd: keep a linked diagram on the latest published version.
//
// Shared links (/s/<slug>) already open the latest version, but opening the
// designer directly (/dbd/, /diagrams/<id>, "Open diagram") shows whatever
// copy is in this browser, which can be several versions behind. Whenever a
// linked diagram is opened, and again when the tab regains focus, ask mango
// for the latest version number:
//   - copy has no unpublished edits → move it to the latest version through
//     the shared-link page (same path as following the link: in place, with
//     the "what changed / what was removed" notice);
//   - copy has unpublished edits → never replace them; show a banner that
//     sends the person to Publish → "Bring in their changes".
// Copies opened from a specific-version link are not linked, so they stay
// on the version that was asked for.

const RECHECK_MS = 30_000;

export interface DbdLatestSyncProps {
    onReview: () => void;
}

export const DbdLatestSync: React.FC<DbdLatestSyncProps> = ({ onReview }) => {
    const { currentDiagram } = useChartDB();
    const { getDiagram } = useStorage();
    const navigate = useNavigate();
    const [behind, setBehind] = useState<{
        diagramId: string;
        localVersion: number;
        latest: ShareVersionMeta;
    } | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const lastCheck = useRef<{ id: string; at: number } | null>(null);
    const inFlight = useRef(false);

    const check = useCallback(
        async (force: boolean) => {
            const id = currentDiagram?.id;
            if (!id || inFlight.current) return;
            const now = Date.now();
            if (
                !force &&
                lastCheck.current?.id === id &&
                now - lastCheck.current.at < RECHECK_MS
            ) {
                return;
            }
            const link = getLinkForDiagram(id);
            if (!link) {
                setBehind(null);
                return;
            }
            inFlight.current = true;
            lastCheck.current = { id, at: now };
            try {
                const { versions } = await dbdApi.listVersions(link.slug);
                const latest = versions.reduce<ShareVersionMeta | null>(
                    (best, v) => (!best || v.version > best.version ? v : best),
                    null
                );
                if (!latest || latest.version <= link.version) {
                    setBehind(null);
                    return;
                }
                const stored = await getDiagram(id);
                if (!hasEditsSinceSync(stored?.updatedAt, link)) {
                    navigate(`/s/${encodeURIComponent(link.slug)}`, {
                        replace: true,
                    });
                    return;
                }
                setBehind({
                    diagramId: id,
                    localVersion: link.version,
                    latest,
                });
            } catch {
                // Offline, signed out, or the share is gone / not visible:
                // keep working on the local copy; the Share dialog reports it.
            } finally {
                inFlight.current = false;
            }
        },
        [currentDiagram?.id, getDiagram, navigate]
    );

    useEffect(() => {
        setBehind(null);
        void check(true);
    }, [check]);

    useEffect(() => {
        const onFocus = () => {
            if (document.visibilityState === 'visible') void check(false);
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, [check]);

    if (
        !behind ||
        behind.diagramId !== currentDiagram?.id ||
        dismissed === `${behind.diagramId}:${behind.latest.version}`
    ) {
        return null;
    }
    const { latest, localVersion } = behind;

    return (
        <div
            role="status"
            className="fixed left-1/2 top-16 z-50 flex w-[32rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs shadow-lg dark:border-amber-800 dark:bg-amber-950/60"
        >
            <div className="flex flex-1 flex-col gap-2">
                <p className="text-sm">
                    Version <b>{latest.version}</b> is out; your copy is on
                    version {localVersion} with changes you have not published.{' '}
                    <span className="text-muted-foreground">
                        Latest by {latest.publishedBy} on{' '}
                        {new Date(latest.publishedAt).toLocaleString()}
                        {latest.note ? `: "${latest.note}"` : '.'}
                    </span>
                </p>
                <Button
                    size="sm"
                    className="h-7 self-start"
                    onClick={() => {
                        setDismissed(
                            `${behind.diagramId}:${behind.latest.version}`
                        );
                        onReview();
                    }}
                >
                    Review and bring in their changes
                </Button>
            </div>
            <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                title="Dismiss"
                onClick={() =>
                    setDismissed(`${behind.diagramId}:${behind.latest.version}`)
                }
            >
                <X className="size-4" />
            </Button>
        </div>
    );
};
