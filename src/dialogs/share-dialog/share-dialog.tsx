import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/dialog/dialog';
import { Button } from '@/components/button/button';
import { Input } from '@/components/input/input';
import { Label } from '@/components/label/label';
import { Textarea } from '@/components/textarea/textarea';
import { Spinner } from '@/components/spinner/spinner';
import { useChartDB } from '@/hooks/use-chartdb';
import {
    dbdApi,
    DbdApiError,
    SLUG_PATTERN,
    toSlug,
    type DbdSession,
    type ShareVersion,
    type StaleBaseConflict,
} from '@/lib/dbd/api';
import {
    buildPublishPayload,
    diagramFromShareVersion,
    shareUrl,
} from '@/lib/dbd/payload';
import { diffDiagrams, overlappingTables } from '@/lib/dbd/diff';
import type { Diagram } from '@/lib/domain/diagram';
import { DiagramDiffView } from './diagram-diff-view';
import {
    buildHighlights,
    clearHighlights,
    setHighlights,
} from '@/lib/dbd/highlight';
import { isEmptyDiff } from '@/lib/dbd/diff';
import {
    clearLink,
    getLinkForDiagram,
    hasEditsSinceSync,
    setLink,
    type DiagramLink,
} from '@/lib/dbd/link-store';

export interface ShareDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type Phase =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready' }
    | { kind: 'working' }
    | { kind: 'conflict'; conflict: StaleBaseConflict }
    | { kind: 'done'; published: ShareVersion };

export const ShareDialog: React.FC<ShareDialogProps> = ({
    open,
    onOpenChange,
}) => {
    const { currentDiagram } = useChartDB();
    const [session, setSession] = useState<DbdSession | null>(null);
    const [link, setLinkState] = useState<DiagramLink | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
    const [slug, setSlug] = useState('');
    const [title, setTitle] = useState('');
    const [note, setNote] = useState('');
    const [copied, setCopied] = useState(false);
    // The version this copy was taken from, and the latest one on the server
    // when it is newer: the two sides of "what changed since".
    const [baseDiagram, setBaseDiagram] = useState<Diagram | null>(null);
    const [latest, setLatest] = useState<{
        shared: ShareVersion;
        diagram: Diagram;
    } | null>(null);
    const [reviewError, setReviewError] = useState<string | null>(null);

    const loadReview = useCallback(async (forLink: DiagramLink) => {
        setReviewError(null);
        try {
            const [baseShared, latestShared] = await Promise.all([
                dbdApi.getVersion(forLink.slug, forLink.version),
                dbdApi.getLatest(forLink.slug),
            ]);
            setBaseDiagram(await diagramFromShareVersion(baseShared));
            setLatest(
                latestShared.version > forLink.version
                    ? {
                          shared: latestShared,
                          diagram: await diagramFromShareVersion(latestShared),
                      }
                    : null
            );
        } catch (err) {
            setBaseDiagram(null);
            setLatest(null);
            setReviewError(String((err as Error)?.message ?? err));
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        const existing = getLinkForDiagram(currentDiagram.id);
        setLinkState(existing);
        setSlug(existing?.slug ?? toSlug(currentDiagram.name));
        setTitle(currentDiagram.name);
        setNote('');
        setCopied(false);
        setBaseDiagram(null);
        setLatest(null);
        setReviewError(null);
        setPhase({ kind: 'loading' });
        dbdApi
            .session()
            .then(async (s) => {
                setSession(s);
                if (existing) {
                    await loadReview(existing);
                }
                setPhase({ kind: 'ready' });
            })
            .catch((err: unknown) => {
                setPhase({
                    kind: 'error',
                    message:
                        err instanceof DbdApiError && err.status === 401
                            ? 'You are not signed in. Sign in to mango and try again.'
                            : `Cannot reach the sharing server (${String(
                                  (err as Error)?.message ?? err
                              )}).`,
                });
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, currentDiagram.id]);

    const editedSinceSync = useMemo(
        () =>
            link ? hasEditsSinceSync(currentDiagram.updatedAt, link) : false,
        [link, currentDiagram.updatedAt]
    );

    const mine = useMemo(
        () => (baseDiagram ? diffDiagrams(baseDiagram, currentDiagram) : null),
        [baseDiagram, currentDiagram]
    );
    const theirs = useMemo(
        () =>
            baseDiagram && latest
                ? diffDiagrams(baseDiagram, latest.diagram)
                : null,
        [baseDiagram, latest]
    );
    const overlap = useMemo(
        () => new Set(mine && theirs ? overlappingTables(mine, theirs) : []),
        [mine, theirs]
    );

    const renderReview = () => {
        if (!link) return null;
        if (reviewError) {
            return (
                <p className="text-xs text-destructive">
                    Could not load version {link.version} to compare:{' '}
                    {reviewError}
                </p>
            );
        }
        return (
            <div className="flex flex-col gap-3">
                {latest && theirs ? (
                    <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40">
                        <p className="text-sm">
                            <b>{latest.shared.publishedBy}</b> published version{' '}
                            {latest.shared.version} on{' '}
                            {new Date(
                                latest.shared.publishedAt
                            ).toLocaleString()}{' '}
                            after you took version {link.version}
                            {latest.shared.note
                                ? `: "${latest.shared.note}"`
                                : '.'}
                        </p>
                        <DiagramDiffView
                            title={`Their changes (v${link.version} → v${latest.shared.version})`}
                            diff={theirs}
                            overlap={overlap}
                        />
                        {overlap.size > 0 ? (
                            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                                You both changed: {[...overlap].join(', ')}.
                                Publishing yours replaces their version of
                                these.
                            </p>
                        ) : null}
                        <button
                            type="button"
                            className="self-start text-xs underline"
                            onClick={() =>
                                window.open(
                                    shareUrl(link.slug, latest.shared.version),
                                    '_blank'
                                )
                            }
                        >
                            Open version {latest.shared.version} in a new tab
                        </button>
                    </div>
                ) : null}
                {mine ? (
                    <DiagramDiffView
                        title={`Your changes since v${link.version}`}
                        diff={mine}
                        overlap={overlap}
                    />
                ) : null}
                {(mine && !isEmptyDiff(mine)) ||
                (theirs && !isEmptyDiff(theirs)) ? (
                    <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => {
                            setHighlights(
                                buildHighlights({
                                    diagram: currentDiagram,
                                    mine,
                                    theirs,
                                    baseVersion: link.version,
                                    latestVersion:
                                        latest?.shared.version ?? null,
                                })
                            );
                            onOpenChange(false);
                        }}
                    >
                        Highlight on diagram
                    </Button>
                ) : null}
            </div>
        );
    };

    const remember = useCallback(
        (published: ShareVersion) => {
            const next: DiagramLink = {
                slug: published.slug,
                version: published.version,
                syncedAt: Date.now(),
            };
            setLink(currentDiagram.id, next);
            setLinkState(next);
            setPhase({ kind: 'done', published });
            clearHighlights();
        },
        [currentDiagram.id]
    );

    const publish = useCallback(
        async (force: boolean) => {
            setPhase({ kind: 'working' });
            try {
                const payload = buildPublishPayload(
                    currentDiagram,
                    note.trim()
                );
                const published = link
                    ? await dbdApi.publishVersion(link.slug, {
                          ...payload,
                          baseVersion: link.version,
                          force,
                      })
                    : await dbdApi.createShare({
                          ...payload,
                          slug,
                          title: title.trim() || currentDiagram.name,
                      });
                remember(published);
            } catch (err) {
                if (err instanceof DbdApiError && err.staleBase) {
                    // Someone published while the dialog was open: refresh
                    // the comparison before asking.
                    if (link) await loadReview(link);
                    setPhase({ kind: 'conflict', conflict: err.staleBase });
                    return;
                }
                const message =
                    err instanceof DbdApiError && err.slugTaken
                        ? `The link name "${slug}" is already taken. Pick another one.`
                        : String((err as Error)?.message ?? err);
                setPhase({ kind: 'error', message });
            }
        },
        [currentDiagram, link, note, slug, title, remember, loadReview]
    );

    const copy = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }, []);

    const unlink = useCallback(() => {
        clearLink(currentDiagram.id);
        setLinkState(null);
        setSlug(toSlug(currentDiagram.name));
        setPhase({ kind: 'ready' });
    }, [currentDiagram.id, currentDiagram.name]);

    const slugValid = SLUG_PATTERN.test(slug);
    const canPublish = session?.canPublish ?? false;
    const busy = phase.kind === 'working';

    const renderBody = () => {
        switch (phase.kind) {
            case 'loading':
                return (
                    <div className="flex justify-center py-6">
                        <Spinner />
                    </div>
                );
            case 'error':
                return (
                    <p className="text-sm text-destructive">{phase.message}</p>
                );
            case 'conflict':
                return (
                    <div className="flex flex-col gap-3 text-sm">
                        <p>
                            Version {phase.conflict.latestVersion} was published
                            after you took version {link?.version}. Publishing
                            anyway makes yours the latest version; theirs stays
                            in the history.
                        </p>
                        {renderReview()}
                    </div>
                );
            case 'done': {
                const url = shareUrl(phase.published.slug);
                return (
                    <div className="flex flex-col gap-2 text-sm">
                        <p>
                            Published version <b>{phase.published.version}</b>.
                            Anyone with the link gets this version.
                        </p>
                        <div className="flex gap-2">
                            <Input readOnly value={url} />
                            <Button
                                variant="secondary"
                                onClick={() => copy(url)}
                            >
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        </div>
                    </div>
                );
            }
            default:
                break;
        }

        if (link) {
            const url = shareUrl(link.slug);
            return (
                <div className="flex flex-col gap-3 text-sm">
                    <div className="flex gap-2">
                        <Input readOnly value={url} />
                        <Button variant="secondary" onClick={() => copy(url)}>
                            {copied ? 'Copied' : 'Copy'}
                        </Button>
                    </div>
                    <p className="text-muted-foreground">
                        Your copy is based on version {link.version}.{' '}
                        {editedSinceSync
                            ? 'You have changes that are not published yet.'
                            : 'No changes since then.'}
                    </p>
                    {renderReview()}
                    {canPublish ? (
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="dbd-note">
                                What changed (optional)
                            </Label>
                            <Textarea
                                id="dbd-note"
                                rows={2}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                            />
                        </div>
                    ) : (
                        <p>You can copy the link but not publish.</p>
                    )}
                    <button
                        type="button"
                        className="self-start text-xs text-muted-foreground underline"
                        onClick={unlink}
                    >
                        Unlink this diagram (share it as a new link instead)
                    </button>
                </div>
            );
        }

        return canPublish ? (
            <div className="flex flex-col gap-3 text-sm">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="dbd-title">Title</Label>
                    <Input
                        id="dbd-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <Label htmlFor="dbd-slug">Link name</Label>
                    <Input
                        id="dbd-slug"
                        value={slug}
                        onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    />
                    <span
                        className={
                            slugValid
                                ? 'text-xs text-muted-foreground'
                                : 'text-xs text-destructive'
                        }
                    >
                        {slugValid
                            ? shareUrl(slug)
                            : 'Lowercase letters, digits and dashes; 2 to 63 characters.'}
                    </span>
                </div>
                <div className="flex flex-col gap-1">
                    <Label htmlFor="dbd-note">Note (optional)</Label>
                    <Textarea
                        id="dbd-note"
                        rows={2}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                    />
                </div>
            </div>
        ) : (
            <p className="text-sm">
                You do not have permission to share diagrams.
            </p>
        );
    };

    const renderPrimary = () => {
        if (phase.kind === 'conflict') {
            return (
                <Button onClick={() => publish(true)}>Publish anyway</Button>
            );
        }
        if (
            phase.kind === 'done' ||
            phase.kind === 'loading' ||
            phase.kind === 'error' ||
            !canPublish
        ) {
            return null;
        }
        return (
            <Button
                disabled={busy || (!link && !slugValid)}
                onClick={() => publish(false)}
            >
                {busy ? (
                    <Spinner className="size-4" />
                ) : link ? (
                    'Publish new version'
                ) : (
                    'Create link'
                )}
            </Button>
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="flex max-h-[90vh] flex-col overflow-y-auto sm:max-w-2xl"
                showClose
            >
                <DialogHeader>
                    <DialogTitle>
                        {link ? 'Publish' : 'Share diagram'}
                    </DialogTitle>
                    <DialogDescription>
                        A snapshot of this diagram is saved as a new version
                        behind the link. Editing stays in your browser until you
                        publish again.
                    </DialogDescription>
                </DialogHeader>
                {renderBody()}
                <DialogFooter className="flex gap-1 md:justify-between">
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                    >
                        Close
                    </Button>
                    {renderPrimary()}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
