# SODAX Builders MCP Server

<p align="center">
  <b>Install from your preferred MCP directory</b><br><br>
  <a href="https://glama.ai/mcp/servers/@gosodax/sodax-builders-mcp"><img src="https://img.shields.io/badge/Glama-SODAX_Builders_MCP-4285F4?style=for-the-badge" alt="Glama" /></a>
  &nbsp;
  <a href="https://registry.modelcontextprotocol.io/?q=sodax"><img src="https://img.shields.io/badge/MCP_Registry-SODAX-10B981?style=for-the-badge" alt="MCP Registry" /></a>
  &nbsp;
  <a href="https://mcp.so/server/sodax-builders-mcp/gosodax"><img src="https://img.shields.io/badge/mcp.so-SODAX_Builders_MCP-8B5CF6?style=for-the-badge" alt="mcp.so" /></a>
</p>

SODAX MCP server for AI coding assistants. Access live cross-network (cross-chain) API data: swap tokens across 20+ networks, query money market rates, look up solver volume, and search intent history. Includes full cross-chain SDK documentation that auto-syncs from SODAX developer docs. Build cross-network DeFi integrations with real-time protocol data directly in your development workflow. With a SODAX API key, it also quotes and tracks swaps that the user's own wallet signs.

**One-liner:** SODAX MCP server: live cross-network DeFi API data and auto-updating SDK docs for 20+ networks. Query swaps, lending, solver volume, and intent history, and make swaps the user's wallet signs, from your AI coding assistant.

## Quick Start

Add the MCP server URL to your AI coding assistant's configuration:

```json
{
  "mcpServers": {
    "sodax-builders": {
      "type": "http",
      "url": "https://builders.sodax.com/mcp"
    }
  }
}
```

Works with Claude, Cursor, VS Code, Windsurf, ChatGPT, and other MCP-compatible agents. One connection gives you access to all cross-network API tools and SDK documentation.

### SSE Transport (Legacy)

For clients that don't support streamable HTTP (e.g. Gemini CLI), use the SSE endpoint instead:

```json
{
  "mcpServers": {
    "sodax-builders": {
      "type": "sse",
      "url": "https://builders.sodax.com/sse"
    }
  }
}
```

### API Key

Send your [SODAX API key](https://docs.sodax.com/developers/how-to/api-keys) in an `x-api-key` header. The builder
tools work without one; the swap tools need it. The server forwards it on its calls to the SODAX data API, solver and
Swaps API, and nowhere else (not to the relay either). Over stdio, set `SODAX_API_KEY` instead. A value that isn't a SODAX key
(`sodax_…`) is ignored.

SSE clients send `x-api-key` on `GET /sse` and on every `POST /messages`: each message runs only with the key it
carries, and a session opened with a key refuses a message without that key (HTTP 403). The MCP SDKs' SSE clients
already send their headers on both.

```json
{
  "mcpServers": {
    "sodax-builders": {
      "type": "http",
      "url": "https://builders.sodax.com/mcp",
      "headers": { "x-api-key": "<your key>" }
    }
  }
}
```

In Claude Code: `claude mcp add --transport http sodax-builders https://builders.sodax.com/mcp --header "x-api-key: <your key>"`.

### Profiles

A connection picks which tools it gets with `?profile=<name>` on the URL or the `x-sodax-profile` header (stdio:
`--profile <name>` or `MCP_PROFILE`).

| Profile | Tools |
|---------|-------|
| `all` (default) | The builder tools, plus the swap tools when you send an API key |
| `builder` | The data, relay and SDK docs tools |
| `swap` | The swap tools only. Needs an API key |

An unknown profile is refused with HTTP 400; `swap` without a key with HTTP 403.

### Partner fee

A builder can take a fee on the swaps its agent quotes: `?partnerAddress=<EVM address>&partnerFeeBps=<1-100>` on the
URL, or the `x-sodax-partner-address` and `x-sodax-partner-fee-bps` headers (stdio: `SODAX_PARTNER_FEE_ADDRESS` and
`SODAX_PARTNER_FEE_BPS`). Set both or neither; anything else is refused with HTTP 400. The fee is taken from the
amount sent, is part of the quote, and is never a tool input.

### Swapping

With the `swap` profile, or `all` with a key, an agent swaps for a user like this. The user's wallet signs and sends
every transaction; the server never signs.

1. `sodax_swap_quote` with the chains, tokens, amount and the user's `fromAddress`, plus `toAddress` for a non-EVM
   destination (an EVM one defaults to `fromAddress`). A `ready` quote returns `steps` (an approve when one is
   needed, after a `reset_approve` when the token needs its allowance zeroed first, then the swap), a `quoteId` and
   `expiresAt`, by which the swap must be mined and tracked. Without the addresses it returns a price only.
2. The user's wallet, on the source chain (each step's `tx` carries its `chainId`), signs and sends each step in
   order, each confirmed before the next. A wallet that supports EIP-5792 can send the quote's `batch` in place of the
   steps its `replaces` lists, adding `calls` to its params: those steps' `{to, value, data}`, in order. A
   `reset_approve` still goes first.
3. Right after the swap is sent, `sodax_swap_track` with the swap transaction's `txHash` (from a batch, the hash
   `wallet_getCallsStatus` reports, not the batch id) and the `quoteId` (the quote's `afterSend` says so). Nothing
   submits the swap to SODAX until this call, and a first call after `expiresAt` (within 30 minutes of it) relays the
   deposit for a refund instead; later than that, the server has dropped the quote and alerts its operators. While
   the result has `retryAfterSec`, call it again after that many seconds.
4. To cancel a swap that hasn't been filled, `sodax_swap_cancel` returns the cancel transaction for the wallet to send;
   then call it again with `cancelTxHash`.

`sodax_get_balance` reads a wallet's balance when the user isn't sure they hold enough (the quote doesn't check), and
`sodax_resolve_token` looks a token up when another swap tool returns `UNKNOWN_TOKEN`. Swaps start on an EVM spoke
chain for now (not Sonic, the hub); the destination can be any SODAX swap chain. Every result the tools return carries
a `nextStep` for the agent; an input that fails a tool's schema gets the MCP SDK's validation error instead.

The server only returns transactions, so the agent also needs a wallet tool (or your app's signer) that can:

- give the user's address on the source chain, for `fromAddress`;
- switch to the chain a step's `tx.chainId` names, then send that `tx` (`to`, `value`, `data`) and return its hash;
- tell when a transaction is mined, since each step must be mined before the next;
- optionally, send an EIP-5792 `wallet_sendCalls`, to use the quote's `batch`.

### Safety

The swap tools never sign or move funds. They also:

- refuse inputs that look like a private key, seed phrase or API key, and say so without echoing them;
- trust only their own quote cache and chain data when tracking or cancelling;
- reject slippage and deadlines outside their bounds instead of clamping them;
- warn, never block, when a quote is worth more than `SODAX_SWAP_USD_WARN` USD;
- refuse a quote whose output is worth under 90% of the amount sent (net of any partner fee) at the oracle's prices,
  and warn when the oracle can't price both sides;
- pick canary or production once, at startup (`SODAX_ENV`), never per request;
- take no RPC URL and no partner fee as a tool input;
- keep keys and RPC URLs out of logs, and addresses out of analytics and alerts.

## Tools

### Network Configuration (9 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_supported_chains` | List all blockchain networks supported by SODAX for cross-chain swaps |
| `sodax_check_chain_support` | Check whether SODAX supports a chain by name, ticker, or key (e.g. "Hedera", "HBAR") |
| `sodax_get_swap_tokens` | Get available tokens for cross-network swapping, optionally filtered by chain |
| `sodax_get_all_config` | Get full SODAX configuration (chains + tokens) in one call |
| `sodax_get_all_chains_configs` | Detailed spoke chain configs with contract addresses and RPCs |
| `sodax_get_relay_chain_id_map` | Chain ID to intent relay chain ID mapping |
| `sodax_get_hub_assets` | Hub (Sonic) assets representing spoke tokens |
| `sodax_get_money_market_tokens` | Money market supported tokens by chain |
| `sodax_get_money_market_reserve_assets` | Money market reserve assets |

### Intents & Solver (9 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_transaction` | Look up an intent transaction by hash — status, amounts, and details |
| `sodax_get_intent` | Look up a specific intent by its intent hash |
| `sodax_get_user_transactions` | Get intent/transaction history for a specific wallet address |
| `sodax_get_volume` | Get solver volume data (filled intents) with filtering and pagination |
| `sodax_get_volume_stats` | Get aggregated solver volume statistics |
| `sodax_get_orderbook` | Get current cross-chain orderbook entries from solver |
| `sodax_get_solver_intent` | Get solver-side intent details and fill history |
| `sodax_get_solver_oracle` | Get the solver's oracle prices for every supported (chain, token) pair |
| `sodax_get_solver_quote` | Get a swap quote from the solver (exact_input or exact_output) |

### Intent Relay (3 tools)

| Tool | Description |
|------|-------------|
| `sodax_relay_submit_tx` | Submit a confirmed spoke-chain tx to the intent relay for cross-chain delivery |
| `sodax_relay_get_transaction_packets` | List every cross-chain packet emitted by a source tx |
| `sodax_relay_get_packet` | Fetch a single relay packet by connection serial number |

### AMM & Liquidity (2 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_amm_positions` | Get AMM liquidity provider NFT positions by owner |
| `sodax_get_amm_pool_candles` | Get OHLCV candlestick chart data for an AMM pool |

### Money Market (6 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_money_market_assets` | List all lending/borrowing assets and rates |
| `sodax_get_money_market_asset` | Get detailed info for a specific asset by reserve address |
| `sodax_get_user_position` | Get a user's money market position (supply, borrow, health) |
| `sodax_get_asset_borrowers` | Get borrowers for a specific money market asset |
| `sodax_get_asset_suppliers` | Get suppliers (lenders) for a specific money market asset |
| `sodax_get_all_borrowers` | Get all borrowers across all money market assets |

### Partners & Token (6 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_partners` | List SODAX integration partners across networks |
| `sodax_get_partner_summary` | Get volume and activity summary for a specific partner |
| `sodax_get_token_supply` | Get SODA token supply info (total, circulating, burned) |
| `sodax_get_total_supply` | Get SODA total supply as a plain number |
| `sodax_get_circulating_supply` | Get SODA circulating supply as a plain number |
| `sodax_refresh_cache` | Clear cached data to get fresh results |

### Swaps (need an API key)

| Tool | Description |
|------|-------------|
| `sodax_swap_quote` | Quote a cross-chain swap; with `fromAddress`, the transactions for the user's wallet to sign |
| `sodax_swap_track` | Submit and track a swap once the user's wallet has sent it; repeated calls never resubmit |
| `sodax_swap_cancel` | Cancel a submitted swap that hasn't been filled: the cancel transaction to sign, then the relay |
| `sodax_get_balance` | A wallet's native balance on a chain and, optionally, one token's |
| `sodax_resolve_token` | Look up a token on a chain: address, decimals and hub asset |

See [Swapping](#swapping) for the order they're called in.

### Cross-Chain SDK Documentation (dynamic)

Tools prefixed with `docs_` are automatically proxied from the SODAX docs MCP at docs.sodax.com. They update automatically when documentation changes — no manual sync needed.

| Tool | Description |
|------|-------------|
| `docs_search_sodax_docs` | Search cross-chain SDK docs, integration guides, and code examples |
| `docs_query_docs_filesystem_sodax_docs` | Read a full documentation page from the docs filesystem |
| `docs_list_tools` | List all available documentation tools |
| `docs_health` | Check SDK docs MCP connection status |
| `docs_refresh` | Refresh the tools list from the docs MCP |

## Example Prompts

Once connected, try asking your AI coding assistant:

### Cross-Network Swaps & Tokens
- *"What networks does SODAX support for cross-chain swaps?"*
- *"Get available swap tokens across chains on Base"*
- *"How do I integrate cross-chain swaps with the SODAX SDK?"*

### Swaps (with an API key)
- *"Swap 10 USDC on Arbitrum for ETH on Base from 0x..."*
- *"How much USDC does 0x... hold on Polygon?"*
- *"Is my swap done? The tx hash is 0x..."*
- *"Cancel that swap"*

### Solver Volume & Intent History
- *"Show me cross-network solver volume for today"*
- *"Look up this intent transaction: 0x..."*
- *"Get intent history for this wallet address"*
- *"Quote me 100 USDC into SODA on Sonic"*
- *"What's the current oracle price the solver has for bnUSD on Avalanche?"*

### Cross-Chain Relay
- *"Track the relay packets for this source tx: 0x..."*
- *"Has packet conn_sn=42 from this tx been executed yet?"*

### Money Market & Lending
- *"What are the lending rates on SODAX money market?"*
- *"Show me borrowing APY rates across assets"*
- *"Get my money market position"*

### SDK Documentation
- *"How do I integrate with the SODAX cross-chain SDK?"*
- *"Show me code examples for cross-network token swaps"*
- *"What SDK methods are available for intent-based execution?"*

## Data Sources

| Source | Type | Cache |
|--------|------|-------|
| SODAX Backend API (api.sodax.com/v1/be) | Live cross-network data | 2 min |
| SODAX Solver API (api.sodax.com/v1/intent) | Oracle prices + swap quotes | 2 min (oracle); none (quote) |
| SODAX Intent Relay (api.sodax.com/v1/relay) | Cross-chain packet tracking | none |
| SODAX Swaps API (api.sodax.com/v1/swaps) | Swap token list, quotes and transactions (swap tools) | 2 min for the token list (up to 30 min while the API is down) |
| SODAX SDK (`@sodax/sdk`, `@sodax/types`) | Swap tools: wallet balances, source-tx receipts, NEAR / Stellar recipient checks, address encoding, the pinned swap contracts | Packaged with the release; balance reads kept 5 s; other chain reads uncached |
| Aggregator | Cross-chain swap token data | 2 min |
| SODAX Docs MCP (docs.sodax.com) | SDK documentation | Auto-sync |

## Local Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start

# Run the unit tests
pnpm test
```

## CI & Local Checks

Every pull request, into any branch, runs `.github/workflows/ci.yml`, which executes the same four checks you can run locally:

| Command | What it does |
|---------|--------------|
| `pnpm checkTs` | Type-checks the project, and the scripts under `scripts/`, with `tsc --noEmit` (no build output). |
| `pnpm lint` | Runs Biome (`biome check .`) over the repo. Add `:fix` to auto-apply safe fixes. |
| `pnpm build` | Compiles TypeScript and copies `src/public` into `dist/`. |
| `pnpm test` | Runs the Vitest unit suite (`src/**` and `scripts/**`); the live contract tests are `pnpm test:contract`. |
| `pnpm test:contract` | Runs the swap contract tests against the live Swaps API (canary; `SODAX_ENV=production` for production). Quotes only: nothing is signed or sent. The Drift Check runs them against production; its scheduled and push runs go red when they fail. |
| `pnpm e2e:canary` | Makes one real 5 USDC swap between Arbitrum and Base through a running server's swap tools, signed by a funded test wallet (see below). |

### Canary swap E2E

`.github/workflows/e2e-canary.yml` runs `pnpm e2e:canary` every day, and on demand, against a server it starts in the runner with `SODAX_ENV=canary`. Canary runs on mainnet chains, so it moves real funds: 5 USDC from whichever of Arbitrum and Base holds more to the other, so runs alternate. It never runs on pull requests. A failure posts the failing stage to Discord: `setup` means the swap never started (install, build or the server start failed, or an env value is missing or malformed); `read_wallet` means the balance reads failed; `balance_floor` means the wallet needs a top-up (USDC, or ETH for gas); `quote` means no ready quote came back, its steps weren't the USDC approve and swap this route needs, or its minimum output was under 97% of the amount. Nothing was signed in any of these. `send` means the swap wasn't sent, or the node refused it and no node had it (an approve may have been mined): check the logged swap hash, if there is one; `track` means a swap may be on chain and needs a look; `arrival` means it was solved but the funds haven't reached the destination yet. The script's output is printed after the run, and the server log after a failure, unless a secret (the API key, the wallet key with or without `0x`, an RPC URL's host or path) shows up in either: that fails the run on its own, Discord gets the stage `a secret in the logs`, and neither is printed.

The secrets live in the `canary-e2e` GitHub environment, limited to the default branch: `E2E_WALLET_PRIVATE_KEY` (a wallet used only here), `E2E_SODAX_API_KEY` (a canary key), `DISCORD_WEBHOOK_URL`, and optionally `SODAX_RPC_URL_42161` / `SODAX_RPC_URL_8453`. `AMOUNT` is at most 20. A manual run with an amount the wallet doesn't hold makes a deliberate red run that sends nothing; a manual dry run only quotes, to check the environment and key before the wallet is funded.

To run it locally, start a server with `pnpm build && SODAX_ENV=canary node dist/index.js` (not `pnpm start`, which loads `.env`), then `MCP_URL=http://127.0.0.1:3000/mcp?profile=swap SODAX_API_KEY=… pnpm e2e:canary` with `E2E_WALLET_PRIVATE_KEY` exported from `read -rs` (not typed on the command line, where shell history keeps it). `E2E_DRY_RUN=1` stops after the quote and needs no wallet. Don't run it while the workflow runs: both use the same wallet's nonces.

### Git hooks (husky + commitlint + lint-staged)

`pnpm install` installs the hooks automatically via the `prepare` script:

- **`pre-commit`** — runs `pnpm checkTs`, `pnpm test`, then `lint-staged` (which runs `biome check --write` on staged files, applying both formatting and safe lint fixes).
- **`commit-msg`** — runs `commitlint` against the [Conventional Commits](https://www.conventionalcommits.org/) spec. Messages like `feat: add X` pass; `bad message` is rejected.

To skip the hooks in a one-off emergency:

```bash
HUSKY=0 git commit -m "your message"
```

Don't make a habit of it — CI will still enforce the same checks on the PR.

### Environment Variables

The server auto-loads a `.env` file on startup (via Node's `--env-file-if-exists`
flag; the OpenTelemetry SDK that ships the logs needs Node ≥ 22.15.0). Copy `.env.example` to `.env` for local development;
if no `.env` exists, every variable falls back to the default below. In production,
Coolify injects these directly into the process environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `TRANSPORT` | `http` | Transport mode (`http` or `stdio`) |
| `SODAX_ENV` | `production` | SODAX API host: `production` (`api.sodax.com`) or `canary` (`canary-api.sodax.com`). The relay stays on `api.sodax.com` in both: canary's relay is the testnet one. Anything else stops the server at startup. |
| `SODAX_API_KEY` | - | stdio only: the SODAX API key (`sodax_…`) forwarded on data API, solver and Swaps API calls; the swap tools need it. Ignored over HTTP, where each client sends its own `x-api-key`. |
| `MCP_PROFILE` | `all` | stdio only: the tool profile (`builder`, `swap` or `all`); `--profile` wins. |
| `SODAX_SWAP_TOOLS_ENABLED` | `true` | Kill switch for the swap tools: `false` turns them off without a redeploy of older code (`?profile=swap` then gets HTTP 400, `all` serves the builder tools). `true` or `false`; anything else stops the server at startup. |
| `SODAX_SWAP_USD_WARN` | `10000` | A quote worth more than this many USD (solver oracle price) tells the agent to confirm the amount with the user. It never blocks. A positive number; anything else stops the server at startup. |
| `SODAX_RPC_URL_<chainId>` | SDK default | The RPC the swap tools read an EVM chain through (track, cancel and balances), by chain id (e.g. `SODAX_RPC_URL_42161`); Sonic's (`146`) also carries the hub reads. `https` only; anything else stops the server at startup. Set Polygon (`137`), Ethereum (`1`) and Hedera (`295`) in production: their public defaults are unreliable. Tools never take an RPC URL as input. |
| `SODAX_RPC_URL_<family>` | SDK default | The RPC a non-EVM chain is read through (`sodax_get_balance` reads balances; the quote reads NEAR storage and Stellar trustlines), by family: `SOLANA`, `SUI`, `NEAR`, `ICON`, `STACKS`, `BITCOIN` (an Esplora-style API such as mempool.space, not a node), `STELLAR_HORIZON` and `STELLAR_SOROBAN`. Not Injective: the SDK ignores its RPC setting, so its reads keep the public endpoints. `https` only, and an unknown suffix stops the server at startup. Their public defaults can rate-limit. |
| `SODAX_PARTNER_FEE_ADDRESS`, `SODAX_PARTNER_FEE_BPS` | - | stdio only: the partner fee on swap quotes (see [Partner fee](#partner-fee)). Ignored over HTTP. |
| `NODE_ENV` | - | Set to `production` for deployment |
| `LOG_LEVEL` | `info` | Log verbosity. One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `DISCORD_WEBHOOK_URL` | - | Discord webhook for runtime alerts: server status (start/stop), significant errors (uncaught/unhandled), API-drift summaries and the swap alerts (see *Operating the swap tools*). Empty/unset = silent (staging/local). |
| `OTEL_LOGS_ENABLED` | - | `true` ships every log record to SODAX unified logging over OTLP as well as stderr; anything else, stderr only. With it set, the next three are required: a missing or bad one warns at startup and leaves shipping off. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | - | The log gateway's `/v1/logs` URL (the standard OpenTelemetry variable, used as given). `https` unless `DEPLOYMENT_ENV=dev`. |
| `OTEL_LOGS_TOKEN` | - | The bearer token for that gateway, one per environment. Secret: the deployment's env only. The server sends it as its only header: `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_LOGS_HEADERS` must stay unset. |
| `DEPLOYMENT_ENV` | - | `prod`, `canary`, `staging` or `dev`: the `deployment.environment` the records carry. `staging` is the server that follows `development`. Independent of `SODAX_ENV`, which picks the API host: the test server runs `SODAX_ENV=canary` with `DEPLOYMENT_ENV=staging`. |
| `ORIGIN` | - | The host's label, as `sodax.origin` on the records. Optional. |

## Deployment

### Environments

The server is deployed via Coolify with a branch-based promotion flow:

- **Production** — tracks `master`, serves https://builders.sodax.com
- **Staging** — tracks `development` (internal-only)

Promotion flow:

1. Feature branches → PR into `development` → auto-deploys to **staging** on merge.
2. `development` → PR into `master` → auto-deploys to **production** on merge.

Hotfixes can branch off `master` and PR directly into `master`, then be merged back into `development`.

### Docker

```bash
docker build -t builders-sodax-mcp-server .
docker run -p 3000:3000 builders-sodax-mcp-server
```

### Docker Compose

```bash
docker-compose up -d
```

### Deployment notes

The included `nixpacks.toml` handles deployment automatically. Set these environment variables:
- `PORT=3000`
- `NODE_ENV=production`

Logs go to stderr as JSON (one line per record, URLs and keys redacted). With `OTEL_LOGS_ENABLED=true` the same records also ship to unified logging: every record of one HTTP request (or one stdio tool call) carries `request.id`; each MCP request (`/mcp`, `/messages`, `/sse`, the ones a guard refuses included) gets an `HTTP request` record (`http.method`, `http.route`, `http.status`, `duration.ms`, `mcp.method`; `client.ip_hash` only with `POSTHOG_CLIENT_ID_SECRET` set, as the plain hash could be reversed), a limiter logs its refusals once per client per window as `Rate limited`, and a tool call, each upstream API call and each chain read get a record of their own with dotted attributes (`tool.name`, `url.path` with its parameters masked, `http.status`, `sdk.call`, `chain.key`, `duration.ms`, `swap.status`, `quote.id`, `tx.hash`, `hub_tx.hash`), so a swap can be followed from the agent's call to the answer; a tool that throws logs its class and stack frames at `error` level, never its message. Export is batched and bounded: a gateway outage drops records and never slows a tool call; a stop or crash flushes what it can. `GET /health` reports `unifiedLogging` (`on`, records `written`, `exported` and `failed`, `lastFailureAt`), so a token or allowlist problem shows there before Grafana; a batch the gateway accepted but partly rejected counts as exported and is logged as a warning. The hub's `unified-logging-connect` skill has the connect check.

### Operating the swap tools

Swap quotes live in the server's memory, so:

- Run one replica. Another replica doesn't have the first one's quotes.
- A merge deploys (into `development` for staging, into `master` for production), so check `GET /health` before merging, and before a restart. `swapQuotes.open` counts the quotes whose deposit hasn't reached the backend yet, signed or not, and `swapQuotes.openUntil` is when the last of them expires (its deadline plus 30 minutes). New quotes keep arriving while you wait, so on a busy server the count may not reach 0: deploy at a quiet moment, or once the `openUntil` you read has passed, accepting that quotes made since then are lost. A lost quote only matters if its deposit was sent: that deposit stays on chain until someone relays it.
- Set `DISCORD_WEBHOOK_URL` in production. The stop message and a crash alert say how many quotes were lost (a kill without SIGTERM, such as running out of memory, sends nothing). When an agent then tracks such a deposit with its chain and quoteId (a call with the quoteId alone is first asked for the chain), Discord gets "Swap deposit without its quote: relay it by hand", with the chain and the tx hash. Swap alerts are capped per hour: 20 for deposits this server checked, 5 for deposits it has no quote for (any key can name one) and 5 for tool errors. Past its cap an alert is held and listed in one post at the end of the hour; past 12 held per cap, it is only in the logs (`alert: <kind>`), so check them after a restart that lost many quotes.
- To recover one, relay the deposit tx with `sodax_relay_submit_tx` (the chain's relay id is in `sodax_get_relay_chain_id_map`). That puts the intent on the hub; past its deadline the backend's canceller refunds it, as it does when track relays an expired deposit.
- `SODAX_SWAP_TOOLS_ENABLED=false` turns the swap tools off without a rollback. It takes a restart, so the same wait applies.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page |
| `GET /api` | Server info, tool list and profiles |
| `GET /health` | Health check; `swapQuotes` counts the open swap quotes a restart would lose; `unifiedLogging` says whether log shipping is on and how many records were written, arrived or failed |
| `POST /mcp` | MCP endpoint (streamable HTTP); `?profile=` picks the tools |
| `GET /sse` | SSE endpoint (legacy transport) |
| `POST /messages` | SSE message endpoint |

### Errors and limits

`/mcp` answers HTTP errors with a JSON-RPC error, `{"jsonrpc":"2.0","error":{"code":…,"message":"…"},"id":null}`.
Read `error.message`; `error` is an object here.

| Status | On `/mcp` | `error.code` |
|--------|-----------|--------------|
| 400 | Invalid JSON | -32700 |
| 400 | A batch of more than 10 messages | -32600 |
| 405 | `GET /mcp`: there is no standalone stream | -32000 |
| 413 | A body over 100 kB | -32600 |
| 429 | A rate limit | -32000 |
| 500 | A server error | -32603 |

On `/sse` and `/messages`, the rate limits, an unknown session and server errors answer `{"error":"…"}`; the SSE
transport's own errors (a message it can't parse, for one) are plain text.

Limits are per client IP (IPv6 per /56): 100 requests a minute on all routes, and 60 a minute on `/mcp`, `/sse` and
`/messages`, where each message of a `/mcp` batch counts. A rate-limit 429 carries `Retry-After` and `RateLimit-*`
headers. SSE allows 10 open sessions per client and 200 in all, and closes a session after an hour without a message.

## Related

- **SODAX** — [sodax.com](https://sodax.com)
- **SDK Documentation** — [docs.sodax.com](https://docs.sodax.com) (proxied automatically)

## License

MIT
