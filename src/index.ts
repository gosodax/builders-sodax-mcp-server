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
import { checkGitBookHealth, fetchGitBookTools } from "./services/gitbookProxy.js";
import { withAnalytics, shutdownAnalytics } from "./services/analytics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Creates a fully configured McpServer instance.
 * Used per-request in HTTP mode to avoid transport conflicts
 * when handling parallel requests.
 */
async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "builders-sodax-mcp-server",
    version: "1.0.0"
  });

  // Wrap server.tool() so every tool call is tracked in PostHog
  // ⚠️  Must be called BEFORE registering any tools
  withAnalytics(server);

  registerSodaxApiTools(server);
  await registerGitBookProxyTools(server);

  return server;
}

// GitBook proxy state
let gitbookToolsRegistered = false;
let gitbookInitAttempts = 0;
const MAX_GITBOOK_RETRIES = 3;
const GITBOOK_RETRY_DELAY = 5000; // 5 seconds

/**
 * Warm the GitBook tools cache at startup with retry logic.
 * Tools are cached in the service layer and reused by createServer().
 */
async function warmGitBookCache(retryCount = 0): Promise<boolean> {
  gitbookInitAttempts++;
  console.error(`GitBook proxy init attempt ${retryCount + 1}/${MAX_GITBOOK_RETRIES}...`);
  
  try {
    const tools = await fetchGitBookTools();
    gitbookToolsRegistered = tools.length > 0;
    
    if (tools.length > 0) {
      console.error(`✅ GitBook proxy initialized: ${tools.length} SDK docs tools available`);
      return true;
    } else {
      console.error(`⚠️ GitBook returned 0 tools`);
    }
  } catch (error) {
    console.error(`❌ GitBook proxy attempt ${retryCount + 1} failed:`, error instanceof Error ? error.message : error);
  }
  
  // Retry if we haven't exceeded max attempts
  if (retryCount < MAX_GITBOOK_RETRIES - 1) {
    console.error(`Retrying in ${GITBOOK_RETRY_DELAY / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, GITBOOK_RETRY_DELAY));
    return warmGitBookCache(retryCount + 1);
  }
  
  console.error(`⚠️ GitBook proxy unavailable after ${MAX_GITBOOK_RETRIES} attempts. Meta-tools still available.`);
  return false;
}

async function runStdio(): Promise<void> {
  // Warm GitBook cache before creating server
  console.error("Initializing GitBook SDK docs proxy...");
  await warmGitBookCache();
  
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SODAX Builders MCP server running via stdio");
}

async function runHTTP(): Promise<void> {
  // Warm GitBook cache before starting HTTP server
  console.error("Initializing GitBook SDK docs proxy...");
  await warmGitBookCache();
  
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
    const requestServer = await createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => transport.close());
    await requestServer.connect(transport);
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
        status: gitbookToolsRegistered ? "connected" : "unavailable",
        initAttempts: gitbookInitAttempts,
        hint: gitbookToolsRegistered 
          ? "docs_* tools are ready to use" 
          : "Use docs_list_tools or docs_refresh to check availability"
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

// Flush pending PostHog events on shutdown
process.on("SIGINT", async () => {
  await shutdownAnalytics();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdownAnalytics();
  process.exit(0);
});
