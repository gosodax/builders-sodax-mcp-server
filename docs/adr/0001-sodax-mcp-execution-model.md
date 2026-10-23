# 0001. SODAX MCP execution model

- Status: Proposed
- Date: 2026-10-23
- Issue: #80, part of the agent-executable swaps epic (#79)

## Context

Today this server is a read-only proxy over the SODAX APIs and docs. Agents can ask questions, but they can't act. Phase 1 lets an agent run a cross-chain swap through the server, and the server never holds a key.

What shapes the design:

- The Swaps API builds every transaction: approve, swap and cancel. We never encode one ourselves.
- `submit-tx` expects a source transaction that is already mined, together with the exact intent and relay data from the quote.
- The `includeTxData` option on the quote builds an intent with no deadline and no room for slippage.
- Every MCP user reaches the Swaps API from this server's IP.
- Canary runs on mainnet chains, so a canary swap moves real funds.

## Decisions

### D1. Hosted only; the server never signs

**Context.** Agents that hold their own keys can already use the SDK. A local signing mode would mean handling keys in a public repo.

**Decision.**
- The server runs at `builders.sodax.com` only. Phase 1 has no local signing mode.
- It never signs or broadcasts. It returns unsigned transactions, and the agent signs and sends them with its own wallet tool.

**Consequences.**
- An agent needs a wallet tool next to this server to complete a swap.
- No private key ever reaches the server.

### D2. API keys and rate limits

This changes the epic's D2, which assumed a gateway in front of `builders.sodax.com` and no throttling in the MCP.

**Context.** A partner's limits and swap volume should follow its API key. `builders.sodax.com` isn't behind the API gateway today: the server has its own per-IP limit, and all its outbound calls come from one IP.

**Decision.**
- Stay at `builders.sodax.com`.
- Forward the caller's `x-api-key` on Swaps API calls. It comes from the HTTP header, or from `SODAX_API_KEY` on stdio.
- Until the gateway question under [Open questions](#open-questions) is settled, keep the server's inbound limit and put a small guard on Swaps API calls:
  - keep `submit-tx` under the backend's per-IP limit;
  - on a 429, wait out `Retry-After` instead of retrying at once;
  - tell the agent when to come back (`RATE_LIMITED` with `retryAfterSec`).

**Consequences.**
- A swap submitted with a key is attributed to that key.
- Keyless callers share one IP's budget, so submit throughput is low for now.
- Keyless callers get the same tools, because the backend doesn't require keys yet. If it starts to, they'll be rejected wherever a key is required.

### D3. Client layer: `@sodax/swaps-api`, `@sodax/types` and `viem`

This replaces the epic's plan to use `@sodax/sdk`.

**Context.** The backend builds every transaction, so the SDK's local builders aren't needed, and the full SDK is heavy. Measured on 2026-10-22 with Node 22.15 (`npm i --ignore-scripts`, then `du -sh node_modules` and `npm audit`):
- `@sodax/sdk@2.2.0` with `@sodax/types@2.2.0`: 777 MB, 35 advisories (11 high).
- `@sodax/swaps-api@2.2.0`, the client the SDK wraps, with `@sodax/types@2.2.0` and `viem`: 82 MB, no advisories.

**Decision.**
- Use `@sodax/swaps-api`, `@sodax/types` and `viem`, pinned to exact versions.
- Keep plain REST for the solver, oracle and relay calls, which have no light client. Move the relay base URL to `api.sodax.com/v1/relay`.
- Raise `engines.node` to `>=22.12.0`, which `@sodax/types` requires.

**Consequences.**
- It's the same client the SDK uses, so Swaps API changes reach us through the package.
- The standalone client accepts a custom `fetch`, which the D2 guard needs.
- Once SDK v3 ships chain plugins, our chain readers move to them.

### D4. Tool profiles

**Context.** The server already has 38 tools. One long list makes clients worse at picking a tool, and builders who only read data don't need swap tools.

**Decision.**
- `builder`: today's tools, with names and outputs unchanged.
- `swap`: the five swap tools.
- `all`: both. This is the default.
- Pick one with `?profile=`, the `x-sodax-profile` header, or `--profile` / `MCP_PROFILE` on stdio. An unknown profile is an error, not a silent fallback.

**Consequences.**
- Existing connections get `all`, so they also see the swap tools. To keep today's exact list, connect with `?profile=builder`.
- A swap agent connects to `/mcp?profile=swap` and sees five tools.

### D5. Chains

**Context.** The Swaps API builds source transactions for many chain families, and each has its own quirks.

**Decision.**
- Sources: every chain the Swaps API builds transactions for. That's the EVM chains, Sonic, Solana, Sui, Stellar, Injective, NEAR, ICON, Stacks and Bitcoin. Destinations: any chain.
- Stacks needs `srcPublicKey` and Bitcoin needs a Bound access token. When one is missing, the quote says which.
- Before building a swap to NEAR or Stellar, check that the recipient can hold the token (NEP-141 storage registration, Stellar trustline). Funds sent to an account that isn't ready get stuck.
- No `rpcUrl` input. Operators set RPC URLs per chain through env.

**Consequences.**
- Cancel isn't offered when the source is Solana or Bitcoin, because no endpoint returns the relay data those need.
- A Bitcoin source needs a short-lived token minted in the user's browser, so agents will rarely use one.
- Non-EVM balance and receipt reads are tested on recorded data first, not on live swaps.

### D6. Workflow tools on one action template

**Context.** Tools that mirror endpoints leave the hard parts to the model: bigint fields, step order, retries. Phase 2 will add bridge, money market and limit orders.

**Decision.**
- Five tools: `sodax_resolve_token`, `sodax_get_balance`, `sodax_swap_quote`, `sodax_swap_track` and `sodax_swap_cancel`.
- They share one template, `registerActionTool`. It screens inputs for secrets, validates them, turns failures into an error with a code and a next step, returns structured output ending in one `nextStep` sentence, and records analytics.

**Consequences.**
- Phase 2 tools reuse the template.
- Builder tools stay as they are.

## How the swap tools behave

### Quote

- Amounts go in as human units (`"0.5"`), and base units come back alongside.
- The intent is built with `createIntent`, not `includeTxData`. The minimum output comes from the slippage (1 to 500 bps, default 100), and the deadline from `getDeadline` (5 to 60 minutes, default 15).
- The answer shows the expected output, minimum received, solver fee and expiry. The partner fee is always zero today and the API has no speed tier, so neither appears.
- With `fromAddress`, the quote checks the balance and the destination, then lists the steps to sign in order: a reset approve if needed, an approve if needed, then the swap.
- Without `fromAddress`, it's a price quote only.
- The intent is cached under a `quoteId`, so the model never retypes bigint fields.

### Track

- It reads the backend status first. If the swap was already submitted, it just reports the status, so repeated calls never resubmit.
- Otherwise it checks on chain that this transaction is the quoted deposit:
  - on EVM, the receipt succeeded and holds the message log from the chain's SODAX `connection` contract, carrying the relay payload cached with the quote;
  - on other chains, phase 1 checks that the transaction succeeded and was sent from the quote's source address. Each chain reader adds the message check once it can read that chain's logs.
- Matching the transaction input isn't enough. The same bytes can be sent to a different contract, and a smart-wallet batch can succeed while the inner call fails. The message log only exists if the deposit happened.
- Then it calls `submit-tx` once and reports progress in plain words until `solved` or `failed`.

### Cancel

- The first call returns the unsigned cancel transaction. The second, with `cancelTxHash`, checks the receipt and relays it.
- The intent comes from the hub or the quote cache, never from model input.

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

## Other swap MCPs

From each project's MCP docs, checked on 2026-10-23 ([LI.FI](https://docs.li.fi/mcp-server/overview), [deBridge](https://docs.debridge.com/dln-details/mcp/mcp-server)).

- **LI.FI** (`mcp.li.quest/mcp`) is hosted and read-only. `get-quote` returns an unsigned `transactionRequest`, and `get-allowance` and `get-status` are separate tools. An API key in a header raises the rate limit.
- **deBridge** is a stateless proxy over its REST API and needs no key. `create_tx` returns the estimated output with the transaction data. There's no status tool, and it can give the user a link to sign in the deBridge app instead.

We follow the same pattern: look up tokens, quote with unsigned transactions, sign elsewhere, then track. On top of that:

- amounts are in human units;
- the allowance check and the approve transaction come with the quote;
- `track` also submits, because SODAX needs `submit-tx` once the source transaction is mined.

## Open questions

- Should `builders.sodax.com` move behind the API gateway, with the MCP calling the backend internally? Limits would then be enforced once, per real caller, and the D2 guard could go. This needs the gateway and backend owners.
- If `submit-tx` could take only the tx hash and source chain and read the intent from chain, the quote cache's restart window would go away.
