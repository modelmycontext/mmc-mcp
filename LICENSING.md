# Licensing

This repository is **dual-licensed by folder**, not as a whole. The split exists so third-party connector authors can ship proprietary code without inheriting GPL obligations from the server runtime.

## Folder map

| Folder | License | What's in it |
|---|---|---|
| `src/` | **GPL-3.0-or-later** | The MCP server itself: event bus, slice runner, request dispatcher, skill engine, services. |
| `tests/` | **GPL-3.0-or-later** | Test code mirrors `src/`. |
| `sdk/` | **Apache-2.0** | The public API a connector implements: `Connector` interface, `ConnectorContext`, `parseJobInputs`, `extractField`. Self-contained — no `@src/` imports. |
| `connectors/` | **Apache-2.0** | Built-in connector implementations (`json-read`, `json-write`, `file-store`, `file-list`, `budget-top`). Only depend on `@sdk/...`. |
| `docs/` | **Apache-2.0** | Documentation, examples. |
| `config/`, root configs | (covered by repo root licensing — generally not redistributable as-is) | Per-deployment configuration. |

The two top-level license files apply respectively:

- **[`LICENSE`](LICENSE)** — GPL-3.0-or-later, applies to `src/` and `tests/`.
- **[`LICENSE-APACHE`](LICENSE-APACHE)** — Apache 2.0, applies to `sdk/`, `connectors/`, and `docs/`. A copy also lives at [`sdk/LICENSE`](sdk/LICENSE) for clarity.

## What this means in practice

### If you run mmc-mcp internally

Either license is functionally identical for you. GPL-3.0 only triggers obligations on **distribution** — running a fork as a service inside your organisation doesn't count as distribution.

### If you fork and redistribute mmc-mcp + the built-in connectors

The whole bundle is **GPL-3.0-or-later** when distributed: any modifications to `src/` must be shared back. The Apache 2.0 in `sdk/` and `connectors/` doesn't shield you here because GPL is the more restrictive license and dominates the bundle.

### If you author a new third-party connector

You get the most flexibility. Your connector imports only from `@sdk/...` (which is Apache 2.0) and `connectors/` peers (also Apache 2.0). Your connector itself can be:

- Apache 2.0 (matches the SDK)
- MIT, BSD, or any other permissive license
- **Proprietary / closed-source** — fine, because nothing it links against is GPL

The boundary rule is enforced architecturally: `sdk/` MUST NOT import from `@src/...`. We treat any such import as a regression. See [`sdk/README.md`](sdk/README.md) for authoring guidance.

### If you contribute to `src/` itself

Your contributions are GPL-3.0-or-later. Standard inbound = outbound: by opening a PR you're licensing your contribution under the same terms as the file you're modifying.

## Why this split?

**Closed-source connectors are a real need.** A connector that talks to an internal HR system or a paid SaaS may not be open-sourceable for legal, contractual, or competitive reasons. If the SDK were GPL'd, that connector couldn't legally exist.

**The server itself benefits from copyleft.** Forks of the runtime that get distributed are required to share their improvements. We want that — the hard runtime work (event sequencing, slice unification, the deterministic rule evaluator) should stay open.

This is the same pattern as Linux + LGPL libraries, GCC + runtime exception, MongoDB + drivers, etc.

## SPDX headers

Files under `sdk/` carry the SPDX header `// SPDX-License-Identifier: Apache-2.0`. Files under `src/` and `tests/` are covered by the repo-root `LICENSE` file (GPL-3.0-or-later) and don't need a per-file header.

## Questions

If you're unsure whether a particular use is allowed, open an issue tagged `licensing`. Genuine ambiguity should be resolved in code (move shared utilities to `sdk/` rather than reaching into `src/`), not in lawyer-speak.
