// Public SDK types for authoring connectors.
//
// This file defines a minimal *structural* API that the host server fulfils.
// Concrete server-side classes (EventBus, JsonDataSource, SqliteDataSource
// in `src/`) are structurally compatible with these interfaces — connectors
// receive instances of those classes via `ConnectorContext` but only need
// to know about the shape declared here, not the GPL'd implementation.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The event shape a connector publishes to the host event bus. Mirrors the
 * `Event` definition in `src/events/eventBus.ts` — keep these in sync if you
 * extend the bus payload contract.
 */
export interface SdkEvent {
  id: string;
  type: string;
  source: string;
  payload: unknown;
  timestamp: Date;
  sequence?: number;
  /** Workflow-instance id (workflow-instance-isolation RFC). Was `sessionId`. */
  correlationId?: string;
}

/**
 * Minimal event-bus surface a connector needs. The host server's `EventBus`
 * class implements this (plus a richer `subscribe` API the connector layer
 * does not use).
 */
export interface SdkEventBus {
  publish(event: SdkEvent): Promise<void>;
}

/**
 * JSON collection store. Used by built-in connectors like `find-json-record` and
 * `json-write` to read/write records under `data/<collection>.json`.
 */
export interface JsonDataSource {
  read(collection: string): Promise<any[]>;
  write(collection: string, data: any[]): Promise<void>;
}

/**
 * SQLite-backed collection store. Same surface as JsonDataSource — both
 * implement the same `read`/`write` contract so connectors can swap
 * between them transparently.
 */
export interface SqliteDataSource {
  read(collection: string): Promise<any[]>;
  write(collection: string, data: any[]): Promise<void>;
}

/**
 * Data sources available to a connector at runtime. Add a typed slot here
 * (and on the host) when a new persistent backend becomes a first-class
 * concern of the connector layer.
 */
export interface DataSources {
  json: JsonDataSource;
  sqlite: SqliteDataSource;
}

/**
 * MCP-style tool implementation: a 2-arity async function the connector can
 * invoke to delegate to a registered tool (e.g. an external MCP server's
 * tools merged in by the host's `ExternalMcpManager`).
 */
export type McpTool = (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Runtime context handed to a connector's `execute()` method.
 */
export interface ConnectorContext {
  eventBus: SdkEventBus;
  dataSources: DataSources;
  tools: Record<string, McpTool>;
  /** Workflow-instance id, used when stamping `TOOL_CALLED` events and binding
   *  form tokens (workflow-instance-isolation RFC). Was `sessionId`. */
  correlationId?: string;
}

/**
 * The contract every connector implements. Register a connector by adding
 * it to the `connectors` array exported from `/connectors/index.ts`.
 */
export interface Connector {
  name: string;
  description: string;
  inputParams: { name: string; type: string; required: boolean; description: string }[];
  outputParams: { name: string; type: string; description: string }[];
  parse: (section: string) => Record<string, unknown>;
  getAssignedVariables: (params: Record<string, unknown>) => { assignedVariables?: string[] };
  execute: (
    ctx: ConnectorContext,
    params: Record<string, unknown>,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}
