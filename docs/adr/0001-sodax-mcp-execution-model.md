# 0001. SODAX MCP execution model

- Status: Proposed
- Date: 2026-10-23
- Issue: #80, part of the agent-executable swaps epic (#79)

## Context

Today this server is a read-only proxy over the SODAX APIs and docs. Agents can ask questions, but they can't act. Phase 1 lets an agent run a cross-chain swap through the server, and the server never holds a key.

What shapes the design:

- The Swaps API builds every transaction: approve, swap and cancel. We never encode one ourselves.
- `submit-tx` expects a source transaction that is already mined, together with the exact intent and relay data from the quote. It doesn't check that transaction on chain.
- The `includeTxData` option on the quote builds an intent with no deadline and no room for slippage. The backend cancels and refunds expired intents, but never one with no deadline, so an unfilled one stays open until the user cancels it.
- Public RPC endpoints are rate-limited and unreliable. The backend already reads chains through its own RPCs.
- Every MCP user reaches the Swaps API from this server's IP.
- Canary runs on mainnet chains, so a canary swap moves real funds.

## Decisions

### D1. Hosted only; the server never signs

**Context.** Agents that hold their own keys can already use the SDK. A local signing mode would mean handling keys in a public repo.

**Decision.**
- The server runs at `builders.sodax.com` only. Phase 1 has no local signing mode.
- It never signs or broadcasts. It returns unsigned transactions. The agent signs and sends them with its own wallet tool, then passes the tx hash back.

**Consequences.**
- An agent needs a wallet tool next to this server to complete a swap.
- No private key ever reaches the server.

### D2. API keys and rate limits

**Context.** A partner's limits and swap volume should follow its API key. Today `builders.sodax.com` isn't behind the API edge: the server has its own per-IP limit, and all its outbound calls come from one IP.

**Decision.**
- Put `builders.sodax.com` behind the same HAProxy edge as the API, so keys and limits are enforced in one place.
- The swap tools need an API key: `x-api-key` on HTTP, or `SODAX_API_KEY` on stdio. A connection without one gets no swap tools. `?profile=swap` is refused with "API key required" and where to get one, and `all` serves only the builder tools.
- The server only checks that a key is there. Whether it's valid is the backend's call.
- Builder tools stay open without a key. When a key is sent, it goes on every backend call.
- Drop the server's own inbound limit once the edge is in front, so only one counter applies. Behind a proxy it would only see the edge's IP anyway.
- On a 429, wait out `Retry-After` instead of retrying at once, and tell the agent when to come back (`RATE_LIMITED` with `retryAfterSec`). A 401 or 403 becomes "API key required", with where to get one.

**Consequences.**
- Every swap is submitted with a key, attributed to that key and limited by its org.
- Swap traffic doesn't share the server's IP budget. Keyless builder calls still do, until the edge can tell real clients apart behind this server (see [Open questions](#open-questions)).
- A made-up key passes the server's check. Only the backend's key enforcement stops it.

### D3. Client layer: `@sodax/sdk` and `@sodax/types`

**Context.** Phase 1 needs the Swaps API client and a few chain helpers. Later phases add features like money market and staking, which have no backend API that builds transactions yet, and the SDK already covers them. The full SDK is heavy. Measured on 2026-10-22 with Node 22.15 (`npm i --ignore-scripts`, then `du -sh node_modules` and `npm audit`): `@sodax/sdk@2.2.0` with `@sodax/types@2.2.0` is 777 MB with 35 advisories (11 high). The high ones trace back to four packages: `axios`, `bigint-buffer`, `toml` and `ws`.

**Decision.**
- Use `@sodax/sdk` and `@sodax/types`, pinned to exact versions.
- Override `axios`, `bigint-buffer` and `toml` to fixed versions. `ws` has no fix yet, so track it.
- Build one `Sodax` instance from env at boot (production or canary, RPC overrides) for chain helpers. Give each request its own Swaps API client carrying the caller's key, so keys never mix between callers.
- Use SDK clients where they exist, and keep plain REST and the drift check for the rest. Move the relay base URL to `api.sodax.com/v1/relay`.
- Raise `engines.node` to `>=22.12.0`, which `@sodax/types` requires.

**Consequences.**
- Swaps API changes reach us through the SDK.
- Later phases can use SDK features without a new dependency.
- The Docker image grows. The PR records its size.

### D4. Tool profiles

**Context.** The server already has 38 tools. One long list makes clients worse at picking a tool, and builders who only read data don't need swap tools.

**Decision.**
- `builder`: today's tools, with names and outputs unchanged.
- `swap`: the five swap tools.
- `all`: both. This is the default.
- Pick one with `?profile=`, the `x-sodax-profile` header, or `--profile` / `MCP_PROFILE` on stdio. An unknown profile is an error, not a silent fallback.

**Consequences.**
- Existing connections get `all`. Without a key, that's today's tools, unchanged. With a key, the swap tools come too; to keep today's exact list, connect with `?profile=builder`.
- A swap agent connects to `/mcp?profile=swap` with a key and sees five tools.

### D5. Chains

**Context.** The Swaps API builds source transactions for many chain families, and each has its own quirks. Checking a source transaction on chain needs a reader per family.

**Decision.**
- Sources in phase 1: the EVM chains and Sonic. The other sources the Swaps API supports (Solana, Sui, Stellar, Injective, NEAR, ICON, Stacks and Bitcoin) open once the backend checks source transactions in `submit-tx` (see [Track](#track)). Destinations: any chain.
- When those sources open, Stacks needs `srcPublicKey` and Bitcoin needs a Bound access token. When one is missing, the quote says which.
- Before building a swap to NEAR or Stellar, check with the SDK that the recipient can hold the token (NEP-141 storage registration, Stellar trustline). Funds sent to an account that isn't ready get stuck.
- No `rpcUrl` input. Operators set RPC URLs per chain through env. The server reads chains only through the SDK: source transactions on EVM source chains, recipients on NEAR and Stellar, and wallet balances and allowances.

**Consequences.**
- Phase 1 covers the swaps most agents start with, without a reader for every chain family.
- Non-EVM sources wait on backend work.

### D6. Workflow tools on one action template

**Context.** Tools that mirror endpoints leave the hard parts to the model: bigint fields, step order, retries. Phase 2 will add bridge, money market and limit orders.

**Decision.**
- Five tools: `sodax_resolve_token`, `sodax_get_balance`, `sodax_swap_quote`, `sodax_swap_track` and `sodax_swap_cancel`.
- They share one template, `registerActionTool`. It screens inputs for secrets, validates them, turns failures into an error with a code and a next step, returns structured output ending in one `nextStep` sentence, and records analytics.
- Balances and allowances come from the server's own reads through the SDK, on the env RPCs. No backend balance endpoint exists; one may replace these reads later.

**Consequences.**
- Phase 2 tools reuse the template.
- Builder tools stay as they are.
- `sodax_get_balance` and the quote's balance check depend on the SDK and the env RPCs. SDK shortcomings are fixed in the SDK, not worked around in the server.

## How the swap tools behave

### Quote

- Amounts go in as human units (`"0.5"`), and base units come back alongside.
- The intent is built with `createIntent`, not `includeTxData`. The minimum output comes from the slippage (1 to 500 bps, default 100), and the deadline from `getDeadline` (5 to 60 minutes, default 15). An intent that isn't filled in time is cancelled and refunded by the backend.
- The answer shows the expected output, minimum received, solver fee, partner fee and expiry. The API has no speed tier.
- The partner fee comes from the connection, never from tool input:
  - the `x-sodax-partner-address` and `x-sodax-partner-fee-bps` headers;
  - or `partnerAddress` and `partnerFeeBps` in the URL query, for clients that only take a URL;
  - or `SODAX_PARTNER_FEE_ADDRESS` and `SODAX_PARTNER_FEE_BPS` on stdio.

  The address must be a valid EVM address and the fee 1 to 100 bps. Anything else is rejected when connecting. The same fee goes to the quote and the intent, and is cached with them. Without it, there is no partner fee.
- With `fromAddress`, the quote checks the balance and the destination, then lists the steps to sign in order: a reset approve if needed, an approve if needed, then the swap.
- Without `fromAddress`, it's a price quote only.
- The intent is cached under a `quoteId`, so the model never retypes bigint fields.

### Track

- It reads the backend status first. If the swap was already submitted, it just reports the status, so repeated calls never resubmit.
- Otherwise it checks that this transaction is the quoted deposit before calling `submit-tx`. Without the check, a wrong hash, such as the approve's, is queued and later abandoned.
- The right place for the check is `submit-tx` itself, so every client gets it. Until the backend does it, the server checks EVM sources through the env RPCs: the receipt succeeded and holds the message log from the chain's SODAX `connection` contract, carrying the relay payload cached with the quote.
- Matching the transaction input isn't enough. The same bytes can be sent to a different contract, and a smart-wallet batch can succeed while the inner call fails. The message log only exists if the deposit happened.
- Then it calls `submit-tx` once and reports progress in plain words until `solved` or `failed`.

### Cancel

- The first call checks the status. If the swap is already solved, it says so. Otherwise it returns the unsigned cancel transaction.
- The second call, with `cancelTxHash`, checks the receipt and relays it through `/swaps/intents/submit`, because the cancel endpoint only builds the transaction.
- The intent comes from the hub or the quote cache, never from model input.
- Once Solana and Bitcoin sources open, cancel isn't offered for them: relaying needs relay data the cancel endpoint doesn't return. The answer there is to wait for the deadline, after which the backend refunds.

### Quote cache

- It lives in memory. An entry is kept until the intent deadline plus 30 minutes, with at most 10,000 entries. The Bound token is never cached.
- If the server restarts after the user broadcasts but before `track` submits, the entry is lost and the swap sits on chain, unsubmitted.
- The server can't see this on its own. It finds out only when `track` is called again for that transaction and finds neither the quote nor a backend record. It then returns `not_submitted_unknown_quote`, tells the user the swap is on chain but not submitted yet, and alerts the operator with the source chain, tx hash and quote id so they can find the deposit and relay it.
- If nobody calls `track` again, no alert fires.

## Safety rules

- Never sign or broadcast.
- Reject anything that looks like a private key, seed phrase or API key, and explain why. Exempt:
  - tx hashes, which look exactly like EVM private keys;
  - values that validate as an address or token on the chosen chain, since a Sui address or coin type and a NEAR implicit account also contain 64 hex characters;
  - the Bound token.
- `track` and `cancel` trust only the quote cache and on-chain data.
- Slippage and deadline outside their bounds are rejected, not clamped.
- Above a configurable USD value, the quote warns but doesn't block. The user's signature is the real check.
- `SODAX_ENV` chooses production or canary once, at boot. There's no per-request switch.
- No keys or secrets in logs. Analytics carry the `quoteId`, the chains and a USD bucket, never addresses.
- No caller-supplied RPC URLs. A hosted server shouldn't fetch arbitrary URLs, and paid RPC URLs embed their own keys.
- The partner fee is set by the connection, never by tool input, so a prompt can't redirect it.

## Other swap MCPs

From each project's MCP docs, checked on 2026-10-23 ([LI.FI](https://docs.li.fi/mcp-server/overview), [deBridge](https://docs.debridge.com/dln-details/mcp/mcp-server)).

- **LI.FI** (`mcp.li.quest/mcp`) is hosted and read-only. `get-quote` returns an unsigned `transactionRequest`, and `get-allowance` and `get-status` are separate tools. An API key in a header raises the rate limit.
- **deBridge** is a stateless proxy over its REST API and needs no key. `create_tx` returns the estimated output with the transaction data. There's no status tool, and it can give the user a link to sign in the deBridge app instead.

We follow the same pattern: look up tokens, quote with unsigned transactions, sign elsewhere, then track. On top of that:

- amounts are in human units;
- the allowance check and the approve transaction come with the quote;
- `track` also submits, because SODAX needs `submit-tx` once the source transaction is mined.

## Open questions

- Edge setup for this server:
  - One tool call is one request into the server and several backend calls (a quote makes three to six). Should a key be counted on the way in, on the backend calls, or both?
  - The edge's per-IP write cap and jail apply to backend calls from this server's IP. Should the edge trust `X-Forwarded-For` from the server, or exempt its IP?
- Backend work. None of it blocks phase 1; each item would simplify the server:
  - a wallet balance endpoint, so balances on every chain come from one place;
  - `submit-tx` checking the source transaction on chain, which opens non-EVM sources and removes the server's own EVM check;
  - the destination check (NEAR storage, Stellar trustline) in `/swaps/intents`, so every client gets it;
  - `includeTxData` taking slippage and a deadline, so a quote with transaction data is one call;
  - a partner fee per org, read from the API key, so builders don't set it on each connection;
  - `submit-tx` taking only the tx hash and source chain and reading the intent from chain, which removes the quote cache's restart window.
