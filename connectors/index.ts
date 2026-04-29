export type { Connector } from '@sdk/connectorTypes.js';

import { jsonReadConnector } from './json-read.js';
import { jsonWriteConnector } from './json-write.js';
import { jsonPaginatedReadConnector } from './json-paginated-read.js';
import { fileStoreConnector } from './file-store.js';
import { fileListConnector } from './file-list.js';
import { budgetTopConnector } from './budget-top.js';
import { azureBlobDownloadConnector } from './azure-blob-download.js';
import type { Connector } from '@sdk/connectorTypes.js';

// To add a new connector:
// 1. Create connectors/your-connector.ts exporting a Connector object
// 2. Import it here and add it to the connectors array
export const connectors: Connector[] = [jsonReadConnector, jsonWriteConnector, jsonPaginatedReadConnector, fileStoreConnector, fileListConnector, budgetTopConnector, azureBlobDownloadConnector];
