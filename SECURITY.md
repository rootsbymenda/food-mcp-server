# Security Policy

## Reporting a Vulnerability

If you discover a security issue in this MCP server, its optional authentication flow, or its tool handlers, please email **SBD@effortlessai.ai** with:

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
- Authentication flow (optional HMAC-validated MCP key)
- Tool handler logic
- Worker source code in this repository (`src/index.ts`)
- Public API endpoints at `*.workers.dev`

### Out of scope
- The Roots by Benda D1 database itself (access controlled via Worker bindings and route-level protections)
- Third-party dependencies (please report upstream; we track CVEs via Dependabot)
- Social engineering, physical attacks, or attacks requiring previously-stolen credentials

---

## Security Architecture

### Secret Management
All secrets (HMAC keys and third-party API keys, if configured) are managed via **Cloudflare secret bindings** (`wrangler secret put`). **No secret has ever been committed to source control** — verified via filename + content scans across full git history (including all branches), with `.gitignore` defensive patterns blocking accidental future commits of local data dumps.

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

### Authentication and Rate Limiting
No monetization enforcement remains. The optional HMAC key only validates a stable `user_id` for per-user rate limiting; all tools return full data subject to abuse-prevention rate limits.

---

## Public Source — Conscious Decision

This repository is **public-by-design**. Source code visibility serves as the audit trail for technical buyers (CPSR safety assessors, regulatory consultants, formulators) who professionally evaluate compliance tooling. The data discipline, query logic, and cryptographic hygiene are public and auditable.

This decision was made consciously after Perplexity Deep Research evaluation of industry patterns, Smithery scoring impact, MCP community norms, security tradeoffs, and brand-positioning evidence. The full decision rationale is recorded internally; the externally-visible artifact is this repo and its hygiene.

---

## License

See `LICENSE` file in this repository (or `package.json` `license` field). Default for Roots by Benda MCP servers: MIT.
