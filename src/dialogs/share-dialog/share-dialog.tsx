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
    type ShareVisibility,
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
    mergeDiagrams,
    type MergeConflict,
    type Resolution,
} from '@/lib/dbd/merge';
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
    | {
          kind: 'merge';
          conflicts: MergeConflict[];
          resolutions: Record<string, Resolution>;
      }
    | { kind: 'done'; published: ShareVersion };

export const ShareDialog: React.FC<ShareDialogProps> = ({
    open,
    onOpenChange,
}) => {
    const { currentDiagram, updateDiagramData } = useChartDB();
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
    // New shares: private to me, or shared with the team.
    const [visibility, setVisibility] = useState<ShareVisibility>('private');
    // The linked share's visibility and creator, from its latest version.
    const [shareInfo, setShareInfo] = useState<{
        visibility: ShareVisibility;
        owner: string;
    } | null>(null);
    // What "Bring in their changes" took from the newer version, shown once.
    const [broughtIn, setBroughtIn] = useState<{
        version: number;
        applied: string[];
    } | null>(null);

    const loadReview = useCallback(async (forLink: DiagramLink) => {
        setReviewError(null);
        try {
            const [baseShared, latestShared] = await Promise.all([
                dbdApi.getVersion(forLink.slug, forLink.version),
                dbdApi.getLatest(forLink.slug),
            ]);
            setShareInfo({
                visibility: latestShared.visibility ?? 'shared',
                owner: latestShared.owner ?? '',
            });
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
        setBroughtIn(null);
        setShareInfo(null);
        setVisibility('private');
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

    // Applies their changes since the version this copy was taken from onto
    // this copy, then moves the copy's base to their version, so the next
    // Publish is an ordinary one on top of theirs. Conflicts (both changed
    // the same table or column differently) are asked first.
    const bringIn = useCallback(
        async (resolutions?: Record<string, Resolution>) => {
            if (!link || !baseDiagram || !latest) return;
            const result = mergeDiagrams(
                baseDiagram,
                currentDiagram,
                latest.diagram,
                resolutions ?? {}
            );
            if (!resolutions && result.conflicts.length > 0) {
                setPhase({
                    kind: 'merge',
                    conflicts: result.conflicts,
                    resolutions: {},
                });
                return;
            }
            setPhase({ kind: 'working' });
            try {
                // Compare the result with their version: if nothing of mine
                // is left (no edits, or every conflict went their way), the
                // copy now is their version and there is nothing to publish.
                const hasOwnChanges = !isEmptyDiff(
                    diffDiagrams(latest.diagram, result.diagram)
                );
                await updateDiagramData(
                    { ...result.diagram, updatedAt: new Date() },
                    { forceUpdateStorage: true }
                );
                const next: DiagramLink = {
                    slug: link.slug,
                    version: latest.shared.version,
                    syncedAt: hasOwnChanges ? link.syncedAt : Date.now(),
                };
                setLink(currentDiagram.id, next);
                setLinkState(next);
                clearHighlights();
                setBroughtIn({
                    version: latest.shared.version,
                    applied: result.applied,
                });
                await loadReview(next);
                setPhase({ kind: 'ready' });
            } catch (err) {
                setPhase({
                    kind: 'error',
                    message: `Could not bring in their changes: ${String(
                        (err as Error)?.message ?? err
                    )}`,
                });
            }
        },
        [
            link,
            baseDiagram,
            latest,
            currentDiagram,
            updateDiagramData,
            loadReview,
        ]
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
                        {session?.canPublish && baseDiagram ? (
                            <div className="flex flex-col gap-1">
                                <Button
                                    size="sm"
                                    className="self-start"
                                    disabled={phase.kind === 'working'}
                                    onClick={() => bringIn()}
                                >
                                    Bring in their changes
                                </Button>
                                <span className="text-xs text-muted-foreground">
                                    Adds their changes to your copy and keeps
                                    yours, so you publish on top of version{' '}
                                    {latest.shared.version} without losing
                                    theirs. You choose where you both changed
                                    the same thing.
                                </span>
                            </div>
                        ) : null}
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
            setShareInfo({
                visibility: published.visibility ?? 'shared',
                owner: published.owner ?? '',
            });
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
                          visibility,
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
        [
            currentDiagram,
            link,
            note,
            slug,
            title,
            visibility,
            remember,
            loadReview,
        ]
    );

    // One-way: a private design becomes visible to the team.
    const makeShared = useCallback(async () => {
        if (!link) return;
        setPhase({ kind: 'working' });
        try {
            await dbdApi.makeShared(link.slug);
            setShareInfo((info) =>
                info ? { ...info, visibility: 'shared' } : info
            );
            setPhase({ kind: 'ready' });
        } catch (err) {
            setPhase({
                kind: 'error',
                message: `Could not share it: ${String(
                    (err as Error)?.message ?? err
                )}`,
            });
        }
    }, [link]);

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

    const renderMerge = (
        p: Extract<Phase, { kind: 'merge' }>
    ): React.ReactNode => {
        const choose = (key: string, r: Resolution) =>
            setPhase({ ...p, resolutions: { ...p.resolutions, [key]: r } });
        return (
            <div className="flex flex-col gap-3 text-sm">
                <p>
                    You both changed{' '}
                    {p.conflicts.length === 1 ? 'this' : 'these'} since version{' '}
                    {link?.version}. Choose which to keep; every other change
                    from both of you is kept automatically.
                </p>
                <ul className="flex flex-col gap-2">
                    {p.conflicts.map((c) => {
                        const picked = p.resolutions[c.key];
                        return (
                            <li
                                key={c.key}
                                className="flex flex-col gap-1 rounded-md border p-2"
                            >
                                <span className="font-mono text-xs font-medium">
                                    {c.field
                                        ? `${c.table}.${c.field}`
                                        : c.table}
                                </span>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        size="sm"
                                        variant={
                                            picked === 'mine'
                                                ? 'default'
                                                : 'outline'
                                        }
                                        aria-pressed={picked === 'mine'}
                                        onClick={() => choose(c.key, 'mine')}
                                    >
                                        {picked === 'mine' ? '✓ ' : ''}Keep
                                        mine:{' '}
                                        <span className="ml-1 font-mono">
                                            {c.mine}
                                        </span>
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant={
                                            picked === 'theirs'
                                                ? 'default'
                                                : 'outline'
                                        }
                                        aria-pressed={picked === 'theirs'}
                                        onClick={() => choose(c.key, 'theirs')}
                                    >
                                        {picked === 'theirs' ? '✓ ' : ''}Take
                                        theirs:{' '}
                                        <span className="ml-1 font-mono">
                                            {c.theirs}
                                        </span>
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </div>
        );
    };

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
            case 'merge':
                return renderMerge(phase);
            case 'conflict':
                return (
                    <div className="flex flex-col gap-3 text-sm">
                        <p>
                            Version {phase.conflict.latestVersion} was published
                            after you took version {link?.version}.{' '}
                            <b>Bring in their changes</b> to keep both, or{' '}
                            <b>Publish anyway</b> to make your copy the latest
                            as it is: their changes listed below would then be
                            missing from it (they stay in the history).
                        </p>
                        {renderReview()}
                    </div>
                );
            case 'done': {
                const url = shareUrl(phase.published.slug);
                return (
                    <div className="flex flex-col gap-2 text-sm">
                        <p>
                            Published version <b>{phase.published.version}</b>.{' '}
                            {phase.published.visibility === 'private'
                                ? 'Private: only you can open this link.'
                                : 'Anyone with the link gets this version.'}
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
                    {shareInfo?.visibility === 'private' ? (
                        <div className="flex flex-col gap-1 rounded-md border p-2 text-xs">
                            <p>
                                <b>Private</b>: only you can open this link or
                                see it in the list.
                            </p>
                            {canPublish &&
                            shareInfo.owner === session?.user.email ? (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="self-start"
                                    disabled={busy}
                                    onClick={makeShared}
                                >
                                    Share with the team
                                </Button>
                            ) : null}
                            <span className="text-muted-foreground">
                                Sharing is one-way: a shared design cannot be
                                made private again.
                            </span>
                        </div>
                    ) : shareInfo ? (
                        <p className="text-xs text-muted-foreground">
                            Shared: everyone with the DB designer role can open
                            this link.
                        </p>
                    ) : null}
                    {broughtIn ? (
                        <div className="rounded-md border border-green-300 bg-green-50 p-2 text-xs dark:border-green-800 dark:bg-green-950/40">
                            <p className="font-medium">
                                Brought in version {broughtIn.version}
                                {broughtIn.applied.length
                                    ? ':'
                                    : ' (nothing to add).'}
                            </p>
                            {broughtIn.applied.length ? (
                                <ul className="mt-1 font-mono">
                                    {broughtIn.applied.map((line) => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            ) : null}
                            <p className="mt-1">
                                Check the diagram, then publish to share the
                                combined version.
                            </p>
                        </div>
                    ) : null}
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
                <fieldset className="flex flex-col gap-1">
                    <legend className="mb-1 text-sm font-medium">
                        Who can open it
                    </legend>
                    {(
                        [
                            [
                                'private',
                                'Only me',
                                'A personal design: saved and versioned, but only you see it. You can share it later.',
                            ],
                            [
                                'shared',
                                'Everyone with the DB designer role',
                                'Listed for the team; anyone with the role can open it and publish new versions.',
                            ],
                        ] as const
                    ).map(([value, label, help]) => (
                        <label
                            key={value}
                            className="flex cursor-pointer items-start gap-2 rounded-md border p-2"
                        >
                            <input
                                type="radio"
                                name="dbd-visibility"
                                className="mt-1"
                                checked={visibility === value}
                                onChange={() => setVisibility(value)}
                            />
                            <span className="flex flex-col">
                                <span>{label}</span>
                                <span className="text-xs text-muted-foreground">
                                    {help}
                                </span>
                            </span>
                        </label>
                    ))}
                </fieldset>
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
        if (phase.kind === 'merge') {
            const done = phase.conflicts.every((c) => phase.resolutions[c.key]);
            return (
                <Button
                    disabled={!done}
                    onClick={() => bringIn(phase.resolutions)}
                >
                    Bring in their changes
                </Button>
            );
        }
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
                // While a newer version is waiting, bringing it in is the
                // step to take first; publishing would be refused anyway.
                variant={latest ? 'outline' : 'default'}
                disabled={busy || (!link && !slugValid)}
                onClick={() => publish(false)}
            >
                {busy ? (
                    <Spinner className="size-4" />
                ) : link ? (
                    'Publish new version'
                ) : visibility === 'private' ? (
                    'Save privately'
                ) : (
                    'Create shared link'
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
