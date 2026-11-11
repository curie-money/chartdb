// Remembers which local (IndexedDB) diagram is bound to which shared link.
// localStorage only: losing it just means the next link open imports a fresh copy.

export interface DiagramLink {
    slug: string;
    version: number;
    syncedAt: number; // epoch ms of the last import or publish
}

const linkKey = (diagramId: string) => `dbd:link:${diagramId}`;
const slugKey = (slug: string) => `dbd:slug:${slug}`;

const read = (key: string): string | null => {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
};

const write = (key: string, value: string | null) => {
    try {
        if (value === null) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // storage blocked (private window); the link simply is not remembered
    }
};

export const getLinkForDiagram = (diagramId: string): DiagramLink | null => {
    const raw = read(linkKey(diagramId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as DiagramLink;
        return parsed.slug && Number.isInteger(parsed.version) ? parsed : null;
    } catch {
        return null;
    }
};

export const getDiagramIdForSlug = (slug: string): string | null =>
    read(slugKey(slug));

export const setLink = (diagramId: string, link: DiagramLink) => {
    write(linkKey(diagramId), JSON.stringify(link));
    write(slugKey(link.slug), diagramId);
};

export const clearLink = (diagramId: string) => {
    const link = getLinkForDiagram(diagramId);
    write(linkKey(diagramId), null);
    if (link && getDiagramIdForSlug(link.slug) === diagramId) {
        write(slugKey(link.slug), null);
    }
};

// ChartDB bumps diagram.updatedAt on every edit. Allow a little slack for the
// write that happens while the imported diagram is being stored.
const SYNC_SLACK_MS = 2000;

export const hasEditsSinceSync = (
    diagramUpdatedAt: Date | string | undefined,
    link: DiagramLink
): boolean => {
    if (!diagramUpdatedAt) return false;
    return new Date(diagramUpdatedAt).getTime() > link.syncedAt + SYNC_SLACK_MS;
};
