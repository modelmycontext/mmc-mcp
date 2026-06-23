# Security Policy

## Reporting a Vulnerability

We take the security of `mmc-mcp` seriously. If you find a security vulnerability, please do **not** open a public issue. Instead, please report it to us privately.

### Private Reporting

Please send security reports to: **[arjan@ebdconnect.com]**

We will acknowledge your report within 48 hours and provide a timeline for a fix.

### What to Include

When reporting a vulnerability, please include:
- A description of the vulnerability.
- Steps to reproduce the issue.
- Potential impact.
- Any suggested fixes (if known).

## Policy

- We aim to fix critical security vulnerabilities within 7 days.
- We will publish a security advisory once a fix is available.
- We support only the latest version of `mmc-mcp`.

---

## Threat Model

`mmc-mcp` is a workflow engine. Each deployment serves one organisation, on that organisation's own infrastructure. The same binary supports two transport modes with different threat surfaces. Contributors reviewing changes to transports, logging, identity, or tool dispatch should keep both in mind.

### Mode A — Stdio (Claude Desktop `.mcpb` install)

Single user, single host. The `.mcpb` bundle is launched by Claude Desktop and speaks JSON-RPC over **stdio**. The trust boundary is the host: anything running as the same OS user as Claude Desktop is trusted. The protocol channel itself, however, is integrity-critical.

**Invariants:**

- **Stdout is reserved for JSON-RPC.** `process.stdout` (fd 1) is owned by `StdioServerTransport`. Any byte written there that is not a complete, newline-terminated JSON-RPC message corrupts the channel. Logs, banners, ANSI escapes, `console.log` calls from dependencies, and pretty-printers must go to stderr or a file. The `console.*` aliasing in `src/server/index.ts` and `destination: 2` in `src/utils/logger.ts` enforce this.
- **Untrusted strings must be escape-stripped before reaching any logger.** Tool arguments, event payloads, skill content synced from GitHub, and connector responses are all attacker-influenceable. On stdio, a log line is not a side channel — it *is* the protocol channel. An unescaped newline plus a crafted JSON object becomes a forged server-originated MCP notification that the client will execute.
- **No HTTP listener in this mode.** Claude Desktop talks to the bundle over stdio only. Binding `localhost:3001` from a `.mcpb` install would expose the full tool surface to every other process on the host.

### Mode B — HTTP (deployment on tenant infrastructure)

Single organisation, multiple authenticated callers. The deployment runs on the operating organisation's own infrastructure (their VPC, their server, their k8s cluster). Callers within the org are not adversarial in the SaaS-multi-tenant sense, but they are not uniformly trusted either: developers, agents, contractors, CI runners, and end users all coexist on the corporate network, and not all of them should be able to drive every workflow tool.

The MMC Workbench is the identity provider, via **PropelAuth**. `mmc-mcp` is a PropelAuth resource server: it verifies tokens, it does not issue them.

**Invariants:**

- **Every request is authenticated against PropelAuth.** The `Authorization: Bearer <propelauth-access-token>` header is required. The token is verified against PropelAuth's JWKS, with the issuer pinned to the deployment's configured PropelAuth instance.
- **One deployment = one PropelAuth org.** The deployment's config specifies `MMC_ALLOWED_ORG_ID`. Tokens for users who are not members of that org are rejected with 403, regardless of whether the token itself is otherwise valid. This stops a token issued for org A's PropelAuth tenant from being replayed against org B's deployment.
- **Privileged tools are gated by PropelAuth role.** `register-skills`, force-resync, and any tool that mutates `externalServers` or skill state require `Owner` or `Admin` role within the deployment's org. Regular `Member` role gets workflow tools only. The `tools/list` response is filtered to match the caller's capability set.
- **The `mcp-session-id` header is a session correlator, not an identity.** It must never be used as an authorisation token. Auth is re-evaluated on every request.
- **Host and Origin headers are validated.** Defence-in-depth against DNS rebinding and browser-driven cross-origin attacks. Even with auth, the server rejects `Host` headers that don't match the configured deployment hostname and non-allowlisted `Origin` headers.
- **Session caps.** The HTTP session pool is bounded; `initialize` requests beyond the cap are rejected. Robustness against runaway clients exhausting server memory.

A deployment that violates any of these invariants is not in a supported configuration. The dev-only escape hatch `MMC_DEV_NO_AUTH=1` bypasses authentication, but the server refuses to start in that mode unless it is also bound to loopback, and logs a `WARN` on every request.

**Out of scope for the transport layer:**

- **Workflow-level authorisation** — *which* user can complete *which* slice based on their role in a specific workflow (e.g. only the procurement approver can sign off the procurement-approval slice). This belongs in the skill/workflow model and is consulted by the slice evaluator, not the HTTP middleware. The transport layer makes the user's identity and PropelAuth role *available* to the workflow; what the workflow does with them is a skill-modelling question.
- **Machine-to-machine clients.** Operators who need non-human callers (CI runners, scheduled scripts) create a service-account user in PropelAuth and use that user's credentials. A first-class M2M flow may be added later if demand justifies it.

### Connector trust (both modes)

External MCP servers spawned via `ExternalMcpManager` are child processes. Their stdouts and stderrs are attacker-influenceable in the same sense as the parent's: a malicious or buggy child can write arbitrary bytes to its own stdout, which the parent reads as JSON-RPC. The child-server stdout contract is the same as the parent's — *every line must be valid JSON-RPC* — and the manager should reject and disconnect any child that violates it rather than forwarding garbled output upstream.

In Mode B, a connector that issues real external calls (Slack, GitHub, Xero) does so with the operator's configured credentials. A `Member`-role caller who can invoke connector tools is acting with the operator's credentials at the third-party API. This is by design — the operator has chosen to delegate that capability — but it means privileged-tool gating must be conservative about which connectors are exposed to which roles.

### What is explicitly out of scope

- **Operator credentials at rest.** OpenRouter API keys, GitHub PATs, Slack bot tokens, PropelAuth API keys, and per-connector secrets live in `.env` (Mode B) or are passed via the manifest from Claude Desktop's credential store (Mode A). We do not defend against an attacker who already has read access to those secrets.
- **`SKILL.md` files as untrusted code.** Skills are treated as **configuration**, not as code. Operators who sync skills from a GitHub repo are trusting that repo's contributors. We sanitise skill-derived strings before logging (see Mode A invariants) but do not sandbox skill execution.
- **TLS termination.** Mode B deployments terminate TLS at a reverse proxy (nginx, Caddy, a cloud load balancer) in front of the node process. We do not build TLS into the server itself.
- **Filesystem-level attackers.** `data/` is local persistent storage; an attacker with write access there is already past the threat boundary.
- **PropelAuth itself.** The trust chain depends on PropelAuth's correctness as an identity provider. Vulnerabilities in PropelAuth are reported to PropelAuth, not to us.

### Reporting transport-layer issues

Issues affecting the integrity of the stdio JSON-RPC channel, the authentication model of the HTTP transport, the PropelAuth verification chain, or the trust boundary between parent and child MCP servers are treated as critical and follow the 7-day fix target above.
