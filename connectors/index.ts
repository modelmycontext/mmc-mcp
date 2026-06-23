export type { Connector } from '@sdk/connectorTypes.js';

import type { Connector } from '@sdk/connectorTypes.js';

// ── Core connectors (generic, always shipped) ──────────────────────────────
import { findJsonRecordConnector } from './core/find-json-record.js';
import { jsonWriteConnector } from './core/json-write.js';
import { jsonPaginatedReadConnector } from './core/json-paginated-read.js';
import { fileStoreConnector } from './core/file-store.js';
import { fileListConnector } from './core/file-list.js';
import { azureBlobDownloadConnector } from './core/azure-blob-download.js';
import { sendEmailConnector } from './core/send-email.js';
import { sendNotificationConnector } from './core/send-notification.js';
import { sendEformLinkConnector } from './core/send-eform-link.js';
import { mintFormTokenConnector } from './core/mint-form-token.js';
import { signEnrolmentConnector } from './core/sign-enrolment.js';
import { generateApplicationIdConnector } from './core/generate-application-id.js';

// ── Example connectors (demo-specific; opt-out via env) ─────────────────────
import { budgetTopConnector } from './examples/budget-top.js';
import { loanApplicationFetchConnector } from './examples/loan-application-fetch.js';
import { creditBureauPullConnector } from './examples/credit-bureau-pull.js';
import { adverseActionNotifyConnector } from './examples/adverse-action-notify.js';
import { calculateAgeConnector } from './examples/calculate-age.js';

/**
 * Generic connectors that are part of the runtime's core capability surface.
 * To add a new core connector:
 *   1. Create connectors/core/your-connector.ts exporting a Connector object
 *   2. Import it here and add it to `coreConnectors`
 */
export const coreConnectors: Connector[] = [
  findJsonRecordConnector,
  jsonWriteConnector,
  jsonPaginatedReadConnector,
  fileStoreConnector,
  fileListConnector,
  azureBlobDownloadConnector,
  sendEmailConnector,
  sendNotificationConnector,
  sendEformLinkConnector,
  mintFormTokenConnector,
  signEnrolmentConnector,
  generateApplicationIdConnector,
];

/**
 * Demo / sample-workflow connectors (credit-decisioning, budgeting, etc.).
 * They are NOT part of the generic runtime and exist to make the bundled
 * example workflows runnable. Excluded when
 * `MMC_INCLUDE_EXAMPLE_CONNECTORS=false` so production deployments can ship a
 * clean core-only connector surface.
 */
export const exampleConnectors: Connector[] = [
  budgetTopConnector,
  loanApplicationFetchConnector,
  creditBureauPullConnector,
  adverseActionNotifyConnector,
  calculateAgeConnector,
];

const includeExamples = process.env.MMC_INCLUDE_EXAMPLE_CONNECTORS !== 'false';

// To add a connector: put generic ones in `coreConnectors`, demo ones in
// `exampleConnectors`. Both are merged here unless examples are opted out.
export const connectors: Connector[] = includeExamples
  ? [...coreConnectors, ...exampleConnectors]
  : [...coreConnectors];
