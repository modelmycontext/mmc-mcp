// Bearer-token auth for the HTTP surface (/mcp + the guarded REST routes).
//
// This is now a thin alias over the pluggable auth seam in ./authProvider.ts.
// Behaviour is unchanged from the original MCP_ACCESS_TOKEN_HASH middleware:
// with MMC_AUTH_MODE unset the mode derives from MCP_ACCESS_TOKEN_HASH (set ⇒
// enforce sha256(Bearer), unset ⇒ open for loopback dev / the Test panel), and
// the env is read per-request so a rotated hash takes effect without a restart.
//
// The seam lets a future PropelAuth / SSO adapter slot in via MMC_AUTH_MODE
// without changing any route wiring.
export { authMiddleware as mcpAuthMiddleware } from './authProvider.js';
