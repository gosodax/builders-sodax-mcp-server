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

## Hosted deployment

A hosted deployment is available on [Fronteir AI](https://fronteir.ai/mcp/gosodax-builders-sodax-mcp-server).

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

### Intents & Solver (6 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_transaction` | Look up an intent transaction by hash — status, amounts, and details |
| `sodax_get_intent` | Look up a specific intent by its intent hash |
| `sodax_get_user_transactions` | Get intent/transaction history for a specific wallet address |
| `sodax_get_volume` | Get solver volume data (filled intents) with filtering and pagination |
| `sodax_get_orderbook` | Get current cross-chain orderbook entries from solver |
| `sodax_get_solver_intent` | Get solver-side intent details and fill history |

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
| SODAX API (api.sodax.com) | Live cross-network data | 2 min |
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
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `TRANSPORT` | `http` | Transport mode (`http` or `stdio`) |
| `NODE_ENV` | - | Set to `production` for deployment |

## Deployment

### Docker

```bash
docker build -t builders-sodax-mcp-server .
docker run -p 3000:3000 builders-sodax-mcp-server
```

### Docker Compose

```bash
docker-compose up -d
```

### Railway/Coolify

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
- **Marketing MCP Server** — For marketing teams: `https://marketing.sodax.com/mcp`

## License

MIT
