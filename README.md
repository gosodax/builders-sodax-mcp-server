# SODAX Builders MCP Server 🔧

Live API data and SDK documentation for developers and integration partners. Connect your AI coding assistant to SODAX chains, tokens, transactions, volume, and auto-updating SDK docs—all in one connection.

## Overview

This MCP server provides developers and integration partners with AI-powered access to:
- Supported blockchain networks
- Swap tokens and prices
- Transaction lookup and history
- Trading volume data
- Orderbook entries
- Money market assets and positions
- Integration partners
- SODA token supply
- **SDK Documentation** (auto-proxied from GitBook)

Data is fetched live from api.sodax.com with a 2-minute cache for performance.
SDK documentation is proxied from docs.sodax.com/~gitbook/mcp and auto-updates when docs change.

## Tools

### Core API Data (6 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_supported_chains` | List all supported blockchain networks |
| `sodax_get_swap_tokens` | Get available tokens for swapping |
| `sodax_get_transaction` | Look up transaction by hash |
| `sodax_get_user_transactions` | Get user's transaction history |
| `sodax_get_volume` | Get trading volume data |
| `sodax_get_orderbook` | Get current orderbook entries |

### DeFi & Token Data (5 tools)

| Tool | Description |
|------|-------------|
| `sodax_get_money_market_assets` | List lending/borrowing assets |
| `sodax_get_user_position` | Get user's money market position |
| `sodax_get_partners` | List SODAX integration partners |
| `sodax_get_token_supply` | Get SODA token supply info |
| `sodax_refresh_cache` | Clear cached data |

### SDK Documentation (dynamic)

Tools prefixed with `docs_` are automatically proxied from the GitBook MCP at docs.sodax.com. They update automatically when documentation changes.

| Tool | Description |
|------|-------------|
| `docs_*` | All GitBook tools are dynamically imported |
| `docs_list_tools` | List all available documentation tools |
| `docs_health` | Check GitBook MCP connection status |
| `docs_refresh` | Refresh the tools list from GitBook |

## Quick Start

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sodax-builders": {
      "url": "https://builders.sodax.com/mcp"
    }
  }
}
```

This single connection gives you access to both API data AND SDK documentation.

### Local Development

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

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page |
| `GET /api` | Server info and tool list |
| `GET /health` | Health check |
| `POST /mcp` | MCP endpoint |

## Example Prompts

Once connected, try asking:

### Chains & Tokens
- *"What chains does SODAX support?"*
- *"Get available swap tokens on Base"*
- *"Show me the token list for Ethereum"*

### Transactions & Volume
- *"Show me today's trading volume"*
- *"Look up this transaction: 0x..."*
- *"Get my transaction history for this address"*

### Money Market
- *"What assets can I lend on SODAX?"*
- *"Show me lending APY rates"*
- *"Get my money market position"*

### Token & Partners
- *"What's the SODA token supply?"*
- *"Who are SODAX's integration partners?"*

### SDK Documentation
- *"How do I integrate with SODAX?"*
- *"Show me code examples for swapping tokens"*
- *"What SDK methods are available?"*
- *"List available docs tools"*

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

## Project Structure

```
builders-sodax-mcp-server/
├── src/
│   ├── index.ts               # Entry point
│   ├── constants.ts           # API config
│   ├── types.ts               # TypeScript types
│   ├── services/
│   │   ├── sodaxApi.ts        # SODAX API client
│   │   └── gitbookProxy.ts    # GitBook MCP proxy
│   ├── tools/
│   │   ├── sodaxApi.ts        # API tool definitions
│   │   └── gitbookProxy.ts    # GitBook proxy tools
│   └── public/
│       └── index.html         # Landing page
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
└── nixpacks.toml
```

## Related

- **Marketing MCP Server** - For marketing teams: `https://brand.sodax.com/mcp`
- **SDK Documentation Source** - GitBook: `https://docs.sodax.com` (proxied automatically)

## License

MIT
