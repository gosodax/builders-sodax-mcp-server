#!/usr/bin/env node
/**
 * SODAX Builders MCP Server
 * 
 * Live API data for developers and integration partners.
 * Data fetched live from api.sodax.com.
 * SDK documentation proxied from docs.sodax.com/~gitbook/mcp.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { registerSodaxApiTools } from "./tools/sodaxApi.js";
import { registerGitBookProxyTools, getGitBookToolNames } from "./tools/gitbookProxy.js";
import { checkGitBookHealth } from "./services/gitbookProxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const server = new McpServer({
  name: "builders-sodax-mcp-server",
  version: "1.0.0"
});

// Register SODAX API tools
registerSodaxApiTools(server);

// Register GitBook SDK docs proxy tools (async, done at startup)
let gitbookToolsRegistered = false;
async function initGitBookProxy(): Promise<void> {
  try {
    const count = await registerGitBookProxyTools(server);
    gitbookToolsRegistered = count > 0;
    console.error(`GitBook proxy initialized: ${count} SDK docs tools available`);
  } catch (error) {
    console.error("GitBook proxy initialization failed:", error);
  }
}

// Start GitBook proxy initialization
initGitBookProxy();

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SODAX Builders MCP server running via stdio");
}

async function runHTTP(): Promise<void> {
  const app = express();
  
  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"]
      }
    }
  }));
  
  // Rate limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
  });
  app.use(limiter);
  
  // Stricter rate limit for MCP endpoint
  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 MCP requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many MCP requests, please try again later." }
  });
  
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(join(__dirname, "public")));

  app.get("/health", async (_req: Request, res: Response) => {
    const gitbookHealth = await checkGitBookHealth();
    res.json({ 
      status: "healthy", 
      service: "builders-sodax-mcp-server",
      version: "1.0.0",
      sdkDocsProxy: {
        healthy: gitbookHealth.healthy,
        toolCount: gitbookHealth.toolCount
      }
    });
  });

  app.post("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/", (_req: Request, res: Response) => {
    try {
      const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
      res.type("html").send(html);
    } catch {
      res.redirect("/api");
    }
  });

  app.get("/api", async (_req: Request, res: Response) => {
    // Get dynamic list of GitBook tools
    const gitbookTools = await getGitBookToolNames();
    
    res.json({
      name: "SODAX Builders MCP Server",
      version: "1.0.0",
      description: "Live API data and SDK documentation for developers and integration partners",
      endpoints: { mcp: "/mcp", health: "/health", api: "/api" },
      tools: {
        api: [
          "sodax_get_supported_chains",
          "sodax_get_swap_tokens",
          "sodax_get_transaction",
          "sodax_get_user_transactions",
          "sodax_get_volume",
          "sodax_get_orderbook",
          "sodax_get_money_market_assets",
          "sodax_get_user_position",
          "sodax_get_partners",
          "sodax_get_token_supply",
          "sodax_refresh_cache"
        ],
        sdkDocs: gitbookTools
      },
      sdkDocsProxy: {
        source: "https://docs.sodax.com/~gitbook/mcp",
        description: "SDK documentation tools are proxied from GitBook and update automatically",
        status: gitbookToolsRegistered ? "connected" : "initializing"
      }
    });
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, "0.0.0.0", () => {
    console.error(`SODAX Builders MCP server running on http://0.0.0.0:${port}`);
  });
}

async function main(): Promise<void> {
  const transport = process.env.TRANSPORT || "http";
  if (transport === "stdio") {
    await runStdio();
  } else {
    await runHTTP();
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
