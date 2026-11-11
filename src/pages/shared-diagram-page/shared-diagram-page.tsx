import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Spinner } from '@/components/spinner/spinner';
import { Button } from '@/components/button/button';
import type { Diagram } from '@/lib/domain/diagram';
import { generateDiagramId } from '@/lib/utils';
import { useStorage } from '@/hooks/use-storage';
import { LocalConfigProvider } from '@/context/local-config-context/local-config-provider';
import { StorageProvider } from '@/context/storage-context/storage-provider';
import { ThemeProvider } from '@/context/theme-context/theme-provider';
import { dbdApi, DbdApiError, type ShareVersion } from '@/lib/dbd/api';
import { diagramFromShareVersion } from '@/lib/dbd/payload';
import { clearHighlights } from '@/lib/dbd/highlight';
import { diffDiagrams, isEmptyDiff } from '@/lib/dbd/diff';
import { setUpdateNotice } from '@/lib/dbd/update-notice';
import {
    getDiagramIdForSlug,
    getLinkForDiagram,
    hasEditsSinceSync,
    setLink,
} from '@/lib/dbd/link-store';

type State =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | {
          kind: 'choose';
          shared: ShareVersion;
          localId: string;
          localVersion: number;
      };

const SharedDiagramComponent: React.FC = () => {
    const { slug = '', version } = useParams();
    const navigate = useNavigate();
    const { addDiagram, deleteDiagram, getDiagram } = useStorage();
    const [state, setState] = useState<State>({ kind: 'loading' });
    const started = useRef(false);

    // Writes the shared version into local storage under `id` (replacing
    // whatever is there) and binds that id to the link.
    const importAs = useCallback(
        async (
            shared: ShareVersion,
            id: string,
            bind: boolean,
            converted?: Diagram
        ) => {
            const imported =
                converted ?? (await diagramFromShareVersion(shared));
            const now = new Date();
            const diagram: Diagram = {
                ...imported,
                id,
                name: bind
                    ? imported.name
                    : `${imported.name} (v${shared.version})`,
                createdAt: now,
                updatedAt: now,
            };
            clearHighlights();
            await deleteDiagram(id);
            await addDiagram({ diagram });
            if (bind) {
                setLink(id, {
                    slug: shared.slug,
                    version: shared.version,
                    syncedAt: Date.now(),
                });
            }
            navigate(`/diagrams/${id}`, { replace: true });
        },
        [addDiagram, deleteDiagram, navigate]
    );

    const run = useCallback(async () => {
        let shared: ShareVersion;
        try {
            shared = version
                ? await dbdApi.getVersion(slug, Number(version))
                : await dbdApi.getLatest(slug);
        } catch (err) {
            setState({
                kind: 'error',
                message:
                    err instanceof DbdApiError && err.status === 404
                        ? `No shared diagram called "${slug}"${
                              version ? ` with version ${version}` : ''
                          }.`
                        : err instanceof DbdApiError && err.status === 401
                          ? 'You are not signed in. Sign in to mango and open the link again.'
                          : `Could not load the shared diagram: ${String(
                                (err as Error)?.message ?? err
                            )}`,
            });
            return;
        }

        const localId = getDiagramIdForSlug(slug);
        const link = localId ? getLinkForDiagram(localId) : null;
        const local =
            localId && link?.slug === slug
                ? await getDiagram(localId, {
                      includeTables: true,
                      includeRelationships: true,
                      includeAreas: true,
                  })
                : undefined;

        // A link to one specific version (/s/<slug>/v/<n>) that differs from
        // the version your copy is on opens beside it: following a link to
        // an older version must never roll your copy back.
        if (version && local && link && link.version !== shared.version) {
            await importAs(shared, generateDiagramId(), false);
            return;
        }

        if (!localId || !link || !local) {
            await importAs(shared, generateDiagramId(), true);
            return;
        }

        if (hasEditsSinceSync(local.updatedAt, link)) {
            setState({
                kind: 'choose',
                shared,
                localId,
                localVersion: link.version,
            });
            return;
        }

        if (link.version === shared.version) {
            navigate(`/diagrams/${localId}`, { replace: true });
            return;
        }
        // No unpublished edits: move the copy to the new version without
        // asking, but leave a notice of what that version changed, so
        // nothing disappears from the screen unannounced.
        const incoming = await diagramFromShareVersion(shared);
        const diff = diffDiagrams(local, incoming);
        if (!isEmptyDiff(diff)) {
            setUpdateNotice(localId, {
                slug,
                fromVersion: link.version,
                toVersion: shared.version,
                publishedBy: shared.publishedBy,
                publishedAt: shared.publishedAt,
                note: shared.note,
                diff,
            });
        }
        await importAs(shared, localId, true, incoming);
    }, [slug, version, getDiagram, importAs, navigate]);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        run().catch((err) =>
            setState({
                kind: 'error',
                message: `Could not open the shared diagram: ${String(
                    (err as Error)?.message ?? err
                )}`,
            })
        );
    }, [run]);

    if (state.kind === 'loading') {
        return (
            <section className="flex w-screen flex-col bg-background">
                <Spinner size={'large'} className="mt-20 text-pink-600" />
            </section>
        );
    }

    if (state.kind === 'error') {
        return (
            <section className="mx-auto mt-20 flex max-w-lg flex-col gap-4 px-4 text-sm">
                <p>{state.message}</p>
                <Button
                    className="self-start"
                    variant="secondary"
                    onClick={() => navigate('/')}
                >
                    Go to my diagrams
                </Button>
            </section>
        );
    }

    const { shared, localId, localVersion } = state;
    return (
        <section className="mx-auto mt-20 flex max-w-lg flex-col gap-4 px-4 text-sm">
            <h1 className="text-lg font-semibold">{shared.title}</h1>
            <p>
                You already have this diagram (based on version {localVersion})
                with changes you have not published. The link has version{' '}
                {shared.version}, published by {shared.publishedBy} on{' '}
                {new Date(shared.publishedAt).toLocaleString()}.
            </p>
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => importAs(shared, localId, true)}>
                    Replace mine with version {shared.version}
                </Button>
                <Button
                    variant="secondary"
                    onClick={() => importAs(shared, generateDiagramId(), false)}
                >
                    Open version {shared.version} as a separate copy
                </Button>
                <Button
                    variant="ghost"
                    onClick={() =>
                        navigate(`/diagrams/${localId}`, { replace: true })
                    }
                >
                    Keep mine
                </Button>
            </div>
        </section>
    );
};

export const SharedDiagramPage: React.FC = () => (
    <LocalConfigProvider>
        <StorageProvider>
            <ThemeProvider>
                <SharedDiagramComponent />
            </ThemeProvider>
        </StorageProvider>
    </LocalConfigProvider>
);
