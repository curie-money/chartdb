// Curie dbd: DBML TableGroup <-> ChartDB area.
//
// Stock ChartDB drops TableGroup on DBML import and never writes one on export,
// so grouping only survived the ChartDB JSON format. These helpers make groups
// round-trip through DBML: import turns each TableGroup into an area with its
// tables laid out inside it; export writes one TableGroup per area.

import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { Area } from '@/lib/domain/area';
import { adjustTablePositionsWithoutAreas } from '@/lib/domain/db-table';
import {
    arrangeTablesForArea,
    findContainingArea,
} from '@/lib/utils/area-utils';
import { colorOptions, defaultAreaColor } from '@/lib/colors';
import { generateId } from '@/lib/utils';

export interface DBMLTableGroup {
    name: string;
    color?: string;
    tables: { schema?: string; name: string }[];
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

// Splits `"schema"."table"`, `schema.table`, `"table"` or `table`.
const parseTableRef = (raw: string): { schema?: string; name: string } => {
    const parts = raw.match(/"[^"]+"|[^."\s]+/g) ?? [];
    if (parts.length >= 2) {
        return {
            schema: unquote(parts[parts.length - 2]),
            name: unquote(parts[parts.length - 1]),
        };
    }
    return { name: unquote(parts[0] ?? raw) };
};

const GROUP_PATTERN =
    /TableGroup\s+("[^"]+"|[^\s{[]+)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/gs;

export const extractTableGroups = (dbml: string): DBMLTableGroup[] => {
    const groups: DBMLTableGroup[] = [];
    for (const match of dbml.matchAll(GROUP_PATTERN)) {
        const [, rawName, settings = '', body] = match;
        const color = settings.match(/color\s*:\s*(#[0-9a-fA-F]{3,8})/)?.[1];
        const tables = body
            .split('\n')
            .map((line) => line.replace(/\/\/.*$/, '').trim())
            // skip blank lines and group-level settings such as `Note: '...'`
            .filter((line) => line && !/^note\s*:/i.test(line))
            .map(parseTableRef);
        groups.push({ name: unquote(rawName), color, tables });
    }
    return groups;
};

const GROUP_GAP = 120;
const MAX_ROW_WIDTH = 4200;

// Lays the diagram out as one area per TableGroup (packed in rows), with
// ungrouped tables below. Returns the diagram unchanged when there are no
// groups or none of them match a table.
export const applyTableGroupsAsAreas = (
    diagram: Diagram,
    groups: DBMLTableGroup[]
): Diagram => {
    const tables = diagram.tables ?? [];
    if (groups.length === 0 || tables.length === 0) return diagram;

    const relationships = diagram.relationships ?? [];
    const find = (ref: { schema?: string; name: string }) =>
        tables.find(
            (t) =>
                t.name === ref.name &&
                (!ref.schema || !t.schema || t.schema === ref.schema)
        );

    const assigned = new Set<string>();
    const resolved = groups
        .map((group) => ({
            group,
            members: group.tables.map(find).filter((t): t is DBTable => {
                if (!t || assigned.has(t.id)) return false;
                assigned.add(t.id);
                return true;
            }),
        }))
        .filter((g) => g.members.length > 0);
    if (resolved.length === 0) return diagram;

    const positions = new Map<string, { x: number; y: number }>();
    const parentArea = new Map<string, string>();
    const areas: Area[] = [];
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;

    resolved.forEach(({ group, members }, index) => {
        // First pass sizes the area; second pass places it.
        const sized = arrangeTablesForArea(members, relationships, {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        });
        if (cursorX > 0 && cursorX + sized.requiredWidth > MAX_ROW_WIDTH) {
            cursorX = 0;
            cursorY += rowHeight + GROUP_GAP;
            rowHeight = 0;
        }
        const area: Area = {
            id: generateId(),
            name: group.name,
            x: cursorX,
            y: cursorY,
            width: sized.requiredWidth,
            height: sized.requiredHeight,
            color:
                group.color ??
                colorOptions[index % colorOptions.length] ??
                defaultAreaColor,
            order: index,
        };
        areas.push(area);
        sized.positions.forEach((p) => {
            positions.set(p.id, { x: p.x + cursorX, y: p.y + cursorY });
            parentArea.set(p.id, area.id);
        });
        cursorX += sized.requiredWidth + GROUP_GAP;
        rowHeight = Math.max(rowHeight, sized.requiredHeight);
    });

    const ungrouped = tables.filter((t) => !assigned.has(t.id));
    if (ungrouped.length > 0) {
        const laidOut = adjustTablePositionsWithoutAreas(
            ungrouped.map((t) => ({ ...t })),
            relationships.filter(
                (r) =>
                    !assigned.has(r.sourceTableId) &&
                    !assigned.has(r.targetTableId)
            ),
            'all'
        );
        const minX = Math.min(...laidOut.map((t) => t.x));
        const minY = Math.min(...laidOut.map((t) => t.y));
        const top = cursorY + rowHeight + GROUP_GAP * 2;
        laidOut.forEach((t) =>
            positions.set(t.id, { x: t.x - minX, y: t.y - minY + top })
        );
    }

    return {
        ...diagram,
        tables: tables.map((t) => ({
            ...t,
            ...(positions.get(t.id) ?? {}),
            parentAreaId: parentArea.get(t.id) ?? null,
        })),
        areas: [...(diagram.areas ?? []), ...areas],
    };
};

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

// One TableGroup per area. Membership is what the user sees on the canvas
// (table fully inside the area), falling back to the stored parentAreaId.
export const generateTableGroupsDBML = (diagram: Diagram): string => {
    const areas = diagram.areas ?? [];
    if (areas.length === 0) return '';
    const byId = new Map(areas.map((a) => [a.id, a]));

    const members = new Map<string, DBTable[]>();
    (diagram.tables ?? []).forEach((table) => {
        const area =
            findContainingArea(table, areas) ??
            (table.parentAreaId ? byId.get(table.parentAreaId) : undefined);
        if (!area) return;
        members.set(area.id, [...(members.get(area.id) ?? []), table]);
    });

    return [...areas]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .filter((area) => (members.get(area.id) ?? []).length > 0)
        .map((area) => {
            const lines = (members.get(area.id) ?? [])
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(
                    (t) =>
                        `  ${t.schema ? `${quote(t.schema)}.` : ''}${quote(t.name)}`
                );
            return `TableGroup ${quote(area.name)} [color: ${area.color}] {\n${lines.join('\n')}\n}`;
        })
        .join('\n\n');
};
