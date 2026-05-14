# mmc-mcp connector SDK

Everything in this folder is licensed under **Apache-2.0** (see [`LICENSE`](LICENSE)) — **independent of the GPL-3.0 license that covers the rest of `src/` and the server runtime**.

## Why a separate folder?

The MCP server itself (`src/`, `tests/`, the event bus, the slice runner, the request dispatcher) is GPL-3.0-or-later. That license is copyleft — anyone who distributes a modified server has to share their changes back.

But the connector layer is different. We want third-party authors to be able to ship proprietary connectors that talk to internal services they can't open-source (e.g. an Oracle ERP integration, an internal HR system). For that to be legal, the public API a connector implements has to be permissively licensed.

This folder is that API. Everything here:

- **MUST NOT import from `@src/...`** — that's what makes it independently licensable.
- Is intentionally minimal. If a third-party connector needs more, we add it here on demand rather than letting connectors reach into `src/`.

## What's exported

```ts
import {
  // Types — implement these in your connector.
  type Connector,
  type ConnectorContext,
  type DataSources,
  type McpTool,
  // Helpers for parsing skill markdown — useful in `parse(...)` and
  // `getAssignedVariables(...)` implementations.
  parseJobInputs,
  parseKeyValueBlock,
  extractField,
} from '@sdk';
```

## Authoring a connector

```ts
// my-connector.ts (Apache-2.0 or whatever you choose)
import type { Connector } from '@sdk';
import { parseJobInputs, extractField } from '@sdk';

export const myConnector: Connector = {
  name: 'my-tool',
  description: 'What this connector does',
  inputParams: [/* ... */],
  outputParams: [/* ... */],
  parse: (section) => parseJobInputs(section),
  getAssignedVariables: (params) => ({ assignedVariables: [params.returns] }),
  execute: async (ctx, params, input) => {
    // Talk to your service. Read from ctx.dataSources, publish via
    // ctx.eventBus, call other tools via ctx.tools[...].
    return { /* result */ };
  },
};
```

Register your connector by adding it to the `connectors` array exported from [`/connectors/index.ts`](../connectors/index.ts).

## Built-in connectors

The connectors in `/connectors/` (`json-read`, `json-write`, `file-store`, `file-list`, `budget-top`) are also Apache-2.0 — they only depend on this SDK and on Node/Bun built-ins.

## Boundary rule, restated

| If a file lives in… | License |
|---|---|
| `sdk/` | Apache-2.0 |
| `connectors/` (built-in connectors) | Apache-2.0 |
| `src/` | GPL-3.0-or-later |
| `tests/` | GPL-3.0-or-later (mirrors `src/`) |

`sdk/` and `connectors/` may NOT import from `src/`. `src/` may freely import from `sdk/` (GPL can absorb permissive code; the reverse is what we're avoiding).
