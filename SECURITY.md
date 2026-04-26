# Security Policy

## Reporting a Vulnerability

If you discover a security issue in this MCP server, its authentication flow, or the tier-gating logic, please email **SBD@effortlessai.ai** with:

- A description of the issue
- Steps to reproduce (curl one-liner if possible)
- Affected endpoint or code path
- Your name/handle for credit (optional)

A dedicated `security@rootsbybenda.com` alias is planned; until it lands, the email above is the canonical disclosure contact.

### Response Timeline

| Stage | Target |
|---|---|
| Acknowledgment | within 72 hours |
| Initial assessment | within 7 days |
| Critical fix (P0) | within 30 days |
| Public disclosure coordination | after fix deployed, mutually agreed timeline |

---

## Scope

### In scope
- Authentication flow (HMAC-validated MCP key + Supabase tier check)
- Tool handler tier-gating logic
- Worker source code in this repository (`src/index.ts`)
- Public API endpoints at `*.workers.dev`

### Out of scope
- The Roots by Benda D1 database itself (access controlled via authenticated MCP tool calls; gating enforced server-side, not at source-visibility layer)
- Third-party dependencies (please report upstream; we track CVEs via Dependabot)
- Social engineering, physical attacks, or attacks requiring previously-stolen credentials

---

## Security Architecture

### Secret Management
All secrets (HMAC keys, Supabase service role key, third-party API keys) are managed via **Cloudflare secret bindings** (`wrangler secret put`). **No secret has ever been committed to source control** — verified via filename + content scans across full git history (including all branches), with `.gitignore` defensive patterns blocking accidental future commits of local data dumps.

GitHub push protection and secret scanning are enabled on this public repo (free for public repos).

### HMAC Validation — Constant-Time
The MCP key validation in `src/index.ts` uses an explicit branchless XOR-OR constant-time comparison to prevent timing oracle attacks:

```typescript
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

The loop iterates the full length with no early-exit; differences accumulate via XOR + bitwise OR; the function returns a single boolean. The HMAC primitive itself is `crypto.subtle.sign` (WebCrypto, audited).

### Tier Gating — Server-Side Only
Free vs. paid tier enforcement happens server-side via Supabase `profiles.plan` lookup AFTER HMAC validation. No client-trusted plan claims; the tier is resolved per-request from authoritative Supabase state.

---

## Public Source — Conscious Decision

This repository is **public-by-design**. Source code visibility serves as the audit trail for technical buyers (CPSR safety assessors, regulatory consultants, formulators) who professionally evaluate compliance tooling. The data is private; the gating logic is public; the cryptographic discipline is public — that is the moat.

This decision was made consciously after Perplexity Deep Research evaluation of industry patterns, Smithery scoring impact, MCP community norms, security tradeoffs, and brand-positioning evidence. The full decision rationale is recorded internally; the externally-visible artifact is this repo and its hygiene.

---

## License

See `LICENSE` file in this repository (or `package.json` `license` field). Default for Roots by Benda MCP servers: MIT.
