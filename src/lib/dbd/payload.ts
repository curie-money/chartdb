import type { Diagram } from '@/lib/domain/diagram';
import { DatabaseType } from '@/lib/domain/database-type';
import {
    diagramFromJSONInput,
    diagramToJSONOutput,
} from '@/lib/export-import-utils';
import { generateDBMLFromDiagram } from '@/lib/dbml/dbml-export/dbml-export';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import type { PublishPayload, ShareVersion } from './api';

export const buildPublishPayload = (
    diagram: Diagram,
    note: string
): PublishPayload => {
    const { standardDbml, error } = generateDBMLFromDiagram(diagram);
    if (error) {
        // DBML is what agents read; publishing without it would leave MCP blind.
        throw new Error(`Could not generate DBML for this diagram: ${error}`);
    }
    return {
        format: 'chartdb',
        diagram: JSON.parse(diagramToJSONOutput(diagram)),
        dbml: standardDbml,
        databaseType: diagram.databaseType,
        note,
    };
};

const asDatabaseType = (value: string): DatabaseType =>
    (Object.values(DatabaseType) as string[]).includes(value)
        ? (value as DatabaseType)
        : DatabaseType.GENERIC;

// Turns a shared version into a fresh local diagram (new ids). The caller
// decides which local id it ends up under.
export const diagramFromShareVersion = async (
    shared: ShareVersion
): Promise<Diagram> => {
    if (shared.format === 'chartdb' && shared.diagram) {
        const diagram = diagramFromJSONInput(JSON.stringify(shared.diagram));
        return { ...diagram, name: shared.title || diagram.name };
    }
    const diagram = await importDBMLToDiagram(shared.dbml, {
        databaseType: asDatabaseType(shared.databaseType),
    });
    return { ...diagram, name: shared.title || diagram.name };
};

export const shareUrl = (slug: string, version?: number): string =>
    `${window.location.origin}${import.meta.env.BASE_URL}s/${slug}${
        version ? `/v/${version}` : ''
    }`;
