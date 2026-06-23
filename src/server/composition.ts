// Composition root — constructs the long-lived runtime singletons and the
// resolved filesystem paths. Imported by index.ts (and other server modules)
// so there is one place that wires concrete implementations together.
//
// stdoutGuard is imported first so the console writers are aliased before any
// constructor below can log.
import './stdoutGuard.js';

import path from 'path';
import { fileURLToPath } from 'url';
import { EventBus } from '@src/events/eventBus.js';
import { SqliteEventStore } from '@src/events/sqliteEventStore.js';
import { InMemoryEventStore } from '@src/events/inMemoryEventStore.js';
import { TestAwareEventStore } from '@src/events/testAwareEventStore.js';
import { SqliteDataSource } from '@src/data-sources/sqliteDataSource.js';
import { JsonDataSource } from '@src/data-sources/jsonDataSource.js';
import { LlmService } from '@src/services/llm.js';
import { ToolOutputSchemaCache } from '@src/services/toolOutputSchemaCache.js';
import { ConnectorExecutor } from '@src/connectors/connectorExecutor.js';
import { connectors } from '@connectors/index.js';
import { TodoStore } from '@src/services/todoStore.js';
import { ConsumedJtiStore } from '@src/forms/consumedJtiStore.js';
import { InMemoryTodoStore } from '@src/services/inMemoryTodoStore.js';
import { TestAwareTodoStore } from '@src/services/testAwareTodoStore.js';
import { ExternalMcpManager, type ExternalMcpConfig } from './externalMcpManager.js';
import { getRun } from './workflowRun.js';
import { readConfig } from '../admin/configStore.js';
import { logger } from '@src/utils/logger.js';

/**
 * Test-instance predicate backed by the WorkflowRun aggregate (#73): an
 * instance is test-only iff its run is flagged isTest. Resolves by any alias
 * (the correlationId is a run alias). Replaces the standalone `testSessions`
 * Set the composite stores used to consult.
 */
const isTestCorrelation = (correlationId?: string): boolean =>
  !!correlationId && (getRun(correlationId)?.isTest ?? false);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (overridable via MCP_PROJECT_ROOT) and the runtime skills dir. */
export const projectRoot = process.env.MCP_PROJECT_ROOT ?? path.join(__dirname, '..', '..');
export const skillsDir = path.join(projectRoot, 'skills');
const dataDir = path.join(projectRoot, 'data');

export const eventBus = new EventBus();
export const eventStore = new SqliteEventStore(dataDir);
export const inMemoryEventStore = new InMemoryEventStore();
export const todoStore = new TodoStore(dataDir);

/**
 * Composite store that routes to in-memory or SQLite based on test-session
 * membership. Pass this to any service that needs session-aware event I/O.
 */
export const testAwareEventStore = new TestAwareEventStore(eventStore, inMemoryEventStore, isTestCorrelation);

/**
 * Composite todo store: test sessions → in-memory, production → SQLite. Mirrors
 * testAwareEventStore. Pass this anywhere todos are read/written so test
 * sessions get the same todo/completion semantics without touching the
 * persistent `todos` table.
 */
export const inMemoryTodoStore = new InMemoryTodoStore();
export const testAwareTodoStore = new TestAwareTodoStore(todoStore, inMemoryTodoStore, isTestCorrelation);

export const jsonData = new JsonDataSource(dataDir);
export const sqliteData = new SqliteDataSource(dataDir);

/** Single-use form-token store (replay protection on /external-events). */
export const consumedJtiStore = new ConsumedJtiStore(dataDir);
export const llmService = new LlmService();

// External MCP server configs (data/config.json runtime copy, falling back
// to the config/config.json seed — see src/admin/configStore.ts).
let externalConfigs: ExternalMcpConfig[] = [];
try {
  const config = readConfig(projectRoot);
  externalConfigs = config?.externalServers ?? [];
} catch (err: any) {
  logger.error({ error: err.message }, `[SERVER] Error reading config.json: ${err.message}`);
}

export const externalMcpManager = new ExternalMcpManager(externalConfigs);
export const toolOutputSchemaCache = new ToolOutputSchemaCache(path.join(projectRoot, 'cache'));
externalMcpManager.setSchemaCache(toolOutputSchemaCache);

export const connectorExecutor = new ConnectorExecutor(connectors);
