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
import { hashClientIp, shutdownAnalytics, withAnalytics } from "./services/analytics.js";
import { checkApiDrift } from "./services/apiDriftCheck.js";
import { notifyError, notifyServerStarted, notifyServerStopping } from "./services/discord.js";
import { fetchGitBookTools, getCachedGitBookHealth } from "./services/gitbookProxy.js";
import { formatNetworkCount, renderLandingPage } from "./services/landingPage.js";
import { logger } from "./services/logger.js";
import { getIntegratedNetworksCount } from "./services/sodaxApi.js";
import { getStaticToolCounts, getToolNamesByModule } from "./services/toolRegistry.js";
import { getCachedGitBookToolNames, registerGitBookProxyTools } from "./tools/gitbookProxy.js";
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

/**
 * Seed the module-level tool registry that `/health`, `/api`, and the landing
 * page read their counts from, without touching GitBook. Only the static SODAX
 * + relay tools feed those counts — `getStaticToolCounts()` and
 * `getToolNamesByModule()` skip the `sdkDocs` module, whose live total comes
 * from `getGitBookToolNames()`.
 *
 * `registerAppTool()` records `{name, module, description}` in the registry as a
 * side effect, so a no-op recording server (whose `tool()` does nothing) is
 * enough — no real `McpServer` is built and no MCP registration runs here; that
 * only happens on the per-request servers. Mirrors the fake server in
 * `toolRegistry.test.ts`. This also skips `registerGitBookProxyTools()`, whose
 * blocking GitBook fetch (up to 30s) would otherwise delay HTTP boot when
 * GitBook is unavailable and `warmGitBookCache()` left the cache empty.
 */
function seedToolRegistry(): void {
  const recordingServer = { tool: () => ({}) } as unknown as McpServer;
  registerSodaxApiTools(recordingServer);
  registerSolverRelayTools(recordingServer);
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

  // Seed the tool registry that /health, /api, and the landing page derive
  // their counts from (per-request server instances are only created lazily).
  // Static SODAX + relay tools are all those counts need, so this skips the
  // GitBook proxy registration and never blocks HTTP boot on a GitBook fetch.
  seedToolRegistry();

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

  // Landing page: the HTML template is read once at startup and served with
  // live counts injected server-side (see services/landingPage.ts). These
  // routes must be registered BEFORE express.static, which would otherwise
  // serve the raw template with un-substituted {{PLACEHOLDER}} tokens.
  let landingTemplate: string | null = null;
  try {
    landingTemplate = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
  } catch (error) {
    logger.warn({ err: error }, "Landing page template missing — / will redirect to /api");
  }

  const serveLandingPage = async (_req: Request, res: Response): Promise<void> => {
    if (!landingTemplate) {
      res.redirect("/api");
      return;
    }
    // Best-effort; renderLandingPage falls back to the evergreen floor on null.
    let networks: number | null = null;
    try {
      networks = await getIntegratedNetworksCount();
    } catch (error) {
      logger.warn({ err: error }, "Failed to fetch integrated networks count for landing page");
    }
    // Non-blocking: derive the docs count from the warmed cache so a cold or
    // expired GitBook cache can't stall the landing page on a 30s fetch — it
    // renders with the cached (or meta-only) count instead.
    const sdkDocsToolCount = getCachedGitBookToolNames().length;
    res.type("html").send(renderLandingPage(landingTemplate, { networks, sdkDocsToolCount }));
  };

  app.get("/", serveLandingPage);
  app.get("/index.html", serveLandingPage);

  app.use(express.static(join(__dirname, "public")));

  app.get("/health", async (_req: Request, res: Response) => {
    // Non-blocking: read GitBook health/tool counts from the warmed cache so a
    // cold or expired cache can't stall the health check on a 30s GitBook fetch
    // (orchestrators treat a slow /health as unhealthy). warmGitBookCache() and
    // per-request servers keep the cache fresh; docs_health does the live probe.
    const gitbookHealth = getCachedGitBookHealth();
    const gitbookToolNames = getCachedGitBookToolNames();
    // Per-group breakdown derived from the tool registry. `api` covers backend
    // + solver tools; `relay` the intent-relay tools; `sdkDocs` the dynamic
    // GitBook proxy.
    const staticToolCounts = getStaticToolCounts();
    const apiToolCount = staticToolCounts.api;
    const relayToolCount = staticToolCounts.relay;
    const sdkDocsToolCount = gitbookToolNames.length;
    const totalTools = apiToolCount + relayToolCount + sdkDocsToolCount;
    // Live integrated-networks count (ICON filtered out), mirroring the
    // frontend. Best-effort: a backend hiccup must not fail the health check,
    // so this stays null and callers fall back to the evergreen floor.
    let networks: number | null = null;
    try {
      const count = await getIntegratedNetworksCount();
      // Normalize a non-positive count to null so clients keep the evergreen
      // floor instead of surfacing a "0+" (which is worse than the fallback),
      // mirroring formatNetworkCount's null|0 handling.
      networks = count > 0 ? count : null;
    } catch (error) {
      logger.warn({ err: error }, "Failed to fetch integrated networks count for /health");
    }
    res.json({
      status: "healthy",
      service: "builders-sodax-mcp-server",
      version: SERVER_VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      networks,
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

  app.get("/api", async (_req: Request, res: Response) => {
    // Non-blocking: docs tool list from the warmed cache (see /health) so a cold
    // or expired GitBook cache can't stall the response on a 30s fetch.
    const gitbookTools = getCachedGitBookToolNames();

    // Best-effort live network count for the description; evergreen fallback.
    let networks: number | null = null;
    try {
      networks = await getIntegratedNetworksCount();
    } catch (error) {
      logger.warn({ err: error }, "Failed to fetch integrated networks count for /api");
    }

    res.json({
      name: "SODAX Builders MCP Server",
      version: SERVER_VERSION,
      description: `Live cross-network DeFi API data, AMM analytics, money market insights, and auto-updating SDK docs for ${formatNetworkCount(networks)} networks`,
      endpoints: { mcp: "/mcp", sse: "/sse", messages: "/messages", health: "/health", api: "/api" },
      // Tool lists derived from the tool registry; sdkDocs reflects the live
      // GitBook proxy list.
      tools: {
        ...getToolNamesByModule(),
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
  // A redeploy can deliver a second SIGTERM (or SIGINT) while the 5s Discord
  // notify is still in flight; share fatalExit's `exiting` flag so the first
  // exit path wins and we don't double-post / double-flush analytics.
  if (exiting) return;
  exiting = true;
  await notifyServerStopping(signal);
  await shutdownAnalytics();
  process.exit(0);
}
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
