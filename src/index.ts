#!/usr/bin/env node
/**
 * SODAX Builders MCP Server
 *
 * Live API data for developers and integration partners.
 * Data fetched live from api.sodax.com.
 * SDK documentation proxied from docs.sodax.com/~gitbook/mcp.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { STATIC_TOOL_COUNTS, hashClientIp, shutdownAnalytics, withAnalytics } from "./services/analytics.js";
import { checkApiDrift } from "./services/apiDriftCheck.js";
import { notifyError, notifyServerStarted, notifyServerStopping } from "./services/discord.js";
import { checkGitBookHealth, fetchGitBookTools } from "./services/gitbookProxy.js";
import { logger } from "./services/logger.js";
import { getGitBookToolNames, registerGitBookProxyTools } from "./tools/gitbookProxy.js";
import { registerSodaxApiTools } from "./tools/sodaxApi.js";
import { registerSolverRelayTools } from "./tools/solverRelay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { version: SERVER_VERSION } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

/**
 * Creates a fully configured McpServer instance.
 * Used per-request in HTTP mode to avoid transport conflicts
 * when handling parallel requests.
 */
async function createServer(clientId?: string): Promise<McpServer> {
  const server = new McpServer({
    name: "builders-sodax-mcp-server",
    version: SERVER_VERSION,
  });

  // Wrap server.tool() so every tool call is tracked in PostHog
  // ⚠️  Must be called BEFORE registering any tools
  withAnalytics(server, clientId);

  registerSodaxApiTools(server);
  registerSolverRelayTools(server);
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
  const attempt = retryCount + 1;
  logger.info({ attempt, max: MAX_GITBOOK_RETRIES }, "GitBook proxy init attempt");

  try {
    const tools = await fetchGitBookTools();
    gitbookToolsRegistered = tools.length > 0;

    if (tools.length > 0) {
      logger.info({ toolCount: tools.length }, "✅ GitBook proxy initialized");
      return true;
    }
    logger.warn("⚠️ GitBook returned 0 tools");
  } catch (error) {
    logger.warn({ err: error, attempt }, "GitBook proxy attempt failed");
  }

  // Retry if we haven't exceeded max attempts
  if (retryCount < MAX_GITBOOK_RETRIES - 1) {
    logger.info({ delayMs: GITBOOK_RETRY_DELAY }, "Retrying GitBook proxy init");
    await new Promise(resolve => setTimeout(resolve, GITBOOK_RETRY_DELAY));
    return warmGitBookCache(retryCount + 1);
  }

  logger.warn({ maxAttempts: MAX_GITBOOK_RETRIES }, "⚠️ GitBook proxy unavailable. Meta-tools still available.");
  return false;
}

async function runStdio(): Promise<void> {
  // Warm GitBook cache before creating server
  logger.info("Initializing GitBook SDK docs proxy...");
  await warmGitBookCache();

  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SODAX Builders MCP server running via stdio");
}

async function runHTTP(): Promise<void> {
  // Warm GitBook cache before starting HTTP server
  logger.info("Initializing GitBook SDK docs proxy...");
  await warmGitBookCache();

  const app = express();

  // Trust the reverse proxy (Coolify/Traefik) so X-Forwarded-For is used for rate limiting
  app.set("trust proxy", 1);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
        },
      },
    }),
  );

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use(limiter);

  // Stricter rate limit for MCP endpoint
  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 MCP requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many MCP requests, please try again later." },
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(join(__dirname, "public")));

  app.get("/health", async (_req: Request, res: Response) => {
    const gitbookHealth = await checkGitBookHealth();
    const gitbookToolNames = await getGitBookToolNames();
    // Per-group breakdown derived from analytics' TOOL_GROUPS (single source
    // of truth). `api` covers backend + solver tools; `relay` covers the
    // intent-relay tools; `sdkDocs` is the dynamic GitBook proxy.
    const apiToolCount = STATIC_TOOL_COUNTS.api ?? 0;
    const relayToolCount = STATIC_TOOL_COUNTS.relay ?? 0;
    const sdkDocsToolCount = gitbookToolNames.length;
    const totalTools = apiToolCount + relayToolCount + sdkDocsToolCount;
    res.json({
      status: "healthy",
      service: "builders-sodax-mcp-server",
      version: SERVER_VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      tools: {
        total: totalTools,
        api: apiToolCount,
        relay: relayToolCount,
        sdkDocs: sdkDocsToolCount,
      },
      sdkDocsProxy: {
        healthy: gitbookHealth.healthy,
        toolCount: gitbookHealth.toolCount,
      },
    });
  });

  app.all("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    const clientId = hashClientIp(req.ip || "unknown");
    const requestServer = await createServer(clientId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await requestServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Legacy SSE transport for clients that don't support streamable HTTP (e.g. Gemini CLI)
  const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  app.get("/sse", mcpLimiter, async (req: Request, res: Response) => {
    const clientId = hashClientIp(req.ip || "unknown");
    const sseServer = await createServer(clientId);
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, { transport, server: sseServer });

    res.on("close", () => {
      sseSessions.delete(transport.sessionId);
      transport.close();
    });

    await sseServer.connect(transport);
    await transport.start();
  });

  app.post("/messages", mcpLimiter, async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const session = sseSessions.get(sessionId);
    if (!session) {
      res.status(400).json({ error: "Invalid or expired session. Reconnect via GET /sse." });
      return;
    }
    await session.transport.handlePostMessage(req, res, req.body);
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
      version: SERVER_VERSION,
      description:
        "Live cross-network DeFi API data, AMM analytics, money market insights, and auto-updating SDK docs for 17+ networks",
      endpoints: { mcp: "/mcp", sse: "/sse", messages: "/messages", health: "/health", api: "/api" },
      tools: {
        config: [
          "sodax_get_supported_chains",
          "sodax_get_swap_tokens",
          "sodax_get_all_config",
          "sodax_get_relay_chain_id_map",
          "sodax_get_all_chains_configs",
          "sodax_get_hub_assets",
          "sodax_get_money_market_tokens",
          "sodax_get_money_market_reserve_assets",
        ],
        intents: [
          "sodax_get_transaction",
          "sodax_get_intent",
          "sodax_get_user_transactions",
          "sodax_get_volume",
          "sodax_get_orderbook",
          "sodax_get_solver_intent",
          "sodax_get_solver_oracle",
          "sodax_get_solver_quote",
        ],
        relay: ["sodax_relay_submit_tx", "sodax_relay_get_transaction_packets", "sodax_relay_get_packet"],
        amm: ["sodax_get_amm_positions", "sodax_get_amm_pool_candles"],
        moneyMarket: [
          "sodax_get_money_market_assets",
          "sodax_get_money_market_asset",
          "sodax_get_user_position",
          "sodax_get_asset_borrowers",
          "sodax_get_asset_suppliers",
          "sodax_get_all_borrowers",
        ],
        partnersAndToken: [
          "sodax_get_partners",
          "sodax_get_partner_summary",
          "sodax_get_token_supply",
          "sodax_get_total_supply",
          "sodax_get_circulating_supply",
          "sodax_refresh_cache",
        ],
        sdkDocs: gitbookTools,
      },
      sdkDocsProxy: {
        source: "https://docs.sodax.com/~gitbook/mcp",
        description: "SDK documentation tools are proxied from GitBook and update automatically",
        status: gitbookToolsRegistered ? "connected" : "unavailable",
        initAttempts: gitbookInitAttempts,
        hint: gitbookToolsRegistered
          ? "docs_* tools are ready to use"
          : "Use docs_list_tools or docs_refresh to check availability",
      },
    });
  });

  const port = Number.parseInt(process.env.PORT || "3000");
  app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, `SODAX Builders MCP server running on http://0.0.0.0:${port}`);
    // #38: announce the server is online to Discord (silent when no webhook set).
    void notifyServerStarted({
      version: SERVER_VERSION,
      transport: "http",
      port,
      env: process.env.NODE_ENV || "unset",
    });
    // Non-blocking: compare live OpenAPI spec against registered MCP tools.
    // Log-only at startup; use `pnpm check:drift` for a CI/CLI-gated run.
    // notify: true → POST a summary to DISCORD_WEBHOOK_URL when drift is found
    // and the webhook is set (prod). Empty/unset webhook (staging) = silent.
    void checkApiDrift({ notify: true }).catch(err => {
      logger.warn({ err }, "⚠️  API drift check threw unexpectedly");
    });
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

/**
 * Log a fatal error, best-effort notify Discord (#38), drain the log buffer,
 * then exit 1. The Discord POST is bounded by the notifier's own 5s timeout;
 * a 1s force-exit guards against a stalled flush (e.g. transport worker not
 * draining in dev). Re-entrant calls only log — the first call owns the exit.
 */
let exiting = false;
function fatalExit(context: string, error: unknown): void {
  logger.fatal({ err: error }, context);
  if (exiting) return;
  exiting = true;
  void notifyError(context, error).finally(() => {
    const force = setTimeout(() => process.exit(1), 1000);
    logger.flush(() => {
      clearTimeout(force);
      process.exit(1);
    });
  });
}

main().catch(error => fatalExit("Server failed to start", error));

// #38: surface unexpected runtime failures to Discord, then exit — preserving
// Node's default crash semantics for uncaught errors / unhandled rejections.
process.on("uncaughtException", error => fatalExit("Uncaught exception", error));
process.on("unhandledRejection", reason => fatalExit("Unhandled promise rejection", reason));

/**
 * Graceful shutdown: announce to Discord (#38), flush pending PostHog events,
 * then exit 0. Awaiting the notifier is bounded by its 5s timeout.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  await notifyServerStopping(signal);
  await shutdownAnalytics();
  process.exit(0);
}
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
