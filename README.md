# SODAX Builders MCP Server

<p align="center">
  <b>Install from your preferred MCP directory</b><br><br>
  <a href="https://glama.ai/mcp/servers/@gosodax/sodax-builders-mcp"><img src="https://img.shields.io/badge/Glama-SODAX_Builders_MCP-4285F4?style=for-the-badge" alt="Glama" /></a>
  &nbsp;
  <a href="https://registry.modelcontextprotocol.io/?q=sodax"><img src="https://img.shields.io/badge/MCP_Registry-SODAX-10B981?style=for-the-badge" alt="MCP Registry" /></a>
  &nbsp;
  <a href="https://mcp.so/server/sodax-builders-mcp/gosodax"><img src="https://img.shields.io/badge/mcp.so-SODAX_Builders_MCP-8B5CF6?style=for-the-badge" alt="mcp.so" /></a>
</p>

SODAX MCP server for AI coding assistants. Access live cross-network (cross-chain) API data: swap tokens across 17+ networks, query money market rates, look up solver volume, and search intent history. Includes full cross-chain SDK documentation that auto-syncs from SODAX developer docs. Build cross-network DeFi integrations with real-time protocol data directly in your development workflow.

**One-liner:** SODAX MCP server: live cross-network DeFi API data and auto-updating SDK docs for 17+ networks. Query swaps, lending, solver volume, and intent history from your AI coding assistant.

## Quick Start

Add the MCP server URL to your AI coding assistant's configuration:

```json
{
  "mcpServers": {
    "sodax-builders": {
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
      "url": "https://builders.sodax.com/sse"
    }
  }
}
```

## Tools

### Network Configuration (8 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_supported_chains` | List all blockchain networks supported by SODAX for cross-chain swaps |
| `sodax_get_swap_tokens` | Get available tokens for cross-network swapping, optionally filtered by chain |
| `sodax_get_all_config` | Get full SODAX configuration (chains + tokens) in one call |
| `sodax_get_all_chains_configs` | Detailed spoke chain configs with contract addresses and RPCs |
| `sodax_get_relay_chain_id_map` | Chain ID to intent relay chain ID mapping |
| `sodax_get_hub_assets` | Hub (Sonic) assets representing spoke tokens |
| `sodax_get_money_market_tokens` | Money market supported tokens by chain |
| `sodax_get_money_market_reserve_assets` | Money market reserve assets |

### Intents & Solver (8 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_transaction` | Look up an intent transaction by hash — status, amounts, and details |
| `sodax_get_intent` | Look up a specific intent by its intent hash |
| `sodax_get_user_transactions` | Get intent/transaction history for a specific wallet address |
| `sodax_get_volume` | Get solver volume data (filled intents) with filtering and pagination |
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

### Cross-Chain SDK Documentation (dynamic)

Tools prefixed with `docs_` are automatically proxied from the GitBook MCP at docs.sodax.com. They update automatically when documentation changes — no manual sync needed.

| Tool | Description |
|------|-------------|
| `docs_searchDocumentation` | Search cross-chain SDK docs, integration guides, and code examples |
| `docs_list_tools` | List all available documentation tools |
| `docs_health` | Check GitBook MCP connection status |
| `docs_refresh` | Refresh the tools list from GitBook |

## Example Prompts

Once connected, try asking your AI coding assistant:

### Cross-Network Swaps & Tokens
- *"What networks does SODAX support for cross-chain swaps?"*
- *"Get available swap tokens across chains on Base"*
- *"How do I integrate cross-chain swaps with the SODAX SDK?"*

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
| SODAX Intent Relay (xcall-relay.nw.iconblockchain.xyz) | Cross-chain packet tracking | none |
| Aggregator | Cross-chain swap token data | 2 min |
| GitBook (docs.sodax.com) | SDK documentation | Auto-sync |

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

# Run the test suite (unit tests for drift-check logic)
pnpm test
```

## CI & Local Checks

Every PR into `development`/`master` runs `.github/workflows/ci.yml`, which executes the same four checks you can run locally:

| Command | What it does |
|---------|--------------|
| `pnpm checkTs` | Type-checks the project with `tsc --noEmit` (no build output). |
| `pnpm lint` | Runs Biome (`biome check .`) over the repo. Add `:fix` to auto-apply safe fixes. |
| `pnpm build` | Compiles TypeScript and copies `src/public` into `dist/`. |
| `pnpm test` | Runs the Vitest suite (currently covers the drift-check logic in `src/services/apiDriftCheck.ts`). |

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
flag — requires Node ≥ 22.9.0). Copy `.env.example` to `.env` for local development;
if no `.env` exists, every variable falls back to the default below. In production,
Coolify injects these directly into the process environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `TRANSPORT` | `http` | Transport mode (`http` or `stdio`) |
| `NODE_ENV` | - | Set to `production` for deployment |
| `LOG_LEVEL` | `info` | Log verbosity. One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `DISCORD_WEBHOOK_URL` | - | Discord webhook for runtime alerts: server status (start/stop), significant errors (uncaught/unhandled), and API-drift summaries. Empty/unset = silent (staging/local). |

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

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page |
| `GET /api` | Server info and tool list |
| `GET /health` | Health check |
| `POST /mcp` | MCP endpoint (streamable HTTP) |
| `GET /sse` | SSE endpoint (legacy transport) |
| `POST /messages` | SSE message endpoint |

## Related

- **SODAX** — [sodax.com](https://sodax.com)
- **SDK Documentation** — [docs.sodax.com](https://docs.sodax.com) (proxied automatically)

## License

MIT
