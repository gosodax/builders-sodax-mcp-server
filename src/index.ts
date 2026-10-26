#!/usr/bin/env node
/**
 * SODAX Builders MCP Server
 *
 * Live API data for developers and integration partners.
 * Data fetched live from api.sodax.com.
 * SDK documentation proxied from docs.sodax.com/mcp.
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
import { callerApiKey, resolveConnection } from "./connection.js";
import { SODAX_ENV, SODAX_ENV_ERROR } from "./constants.js";
import { SERVER_VERSION, createServer, seedToolRegistry } from "./server.js";
import { hashClientIp, shutdownAnalytics } from "./services/analytics.js";
import { checkApiDrift } from "./services/apiDriftCheck.js";
import { notifyError, notifyServerStarted, notifyServerStopping } from "./services/discord.js";
import { fetchDocsTools, getCachedDocsHealth } from "./services/docsProxy.js";
import { formatNetworkCount, renderLandingPage } from "./services/landingPage.js";
import { logger } from "./services/logger.js";
import { partnerFeeFromEnv } from "./services/partnerFee.js";
import {
  apiKeyStatus,
  describeProfiles,
  parseSwapToolsEnabled,
  profileFromArgs,
  selectToolsets,
} from "./services/profiles.js";
import {
  type RequestContext,
  parseApiKey,
  runWithRequestContext,
  setFallbackRequestContext,
} from "./services/requestContext.js";
import { getIntegratedNetworksCount } from "./services/sodaxApi.js";
import { getStaticToolCounts, getToolNamesByModule } from "./services/toolRegistry.js";
import { getCachedDocsToolNames } from "./tools/docsProxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// SDK docs proxy state
let docsInitAttempts = 0;
const MAX_DOCS_RETRIES = 3;
const DOCS_RETRY_DELAY = 5000; // 5 seconds

/**
 * Warm the SDK docs tools cache at startup with retry logic.
 * Tools are cached in the service layer and reused by createServer().
 */
async function warmDocsCache(retryCount = 0): Promise<boolean> {
  docsInitAttempts++;
  const attempt = retryCount + 1;
  logger.info({ attempt, max: MAX_DOCS_RETRIES }, "SDK docs proxy init attempt");

  try {
    // force: each startup attempt must reach upstream, not the failure back-off.
    const tools = await fetchDocsTools({ force: true });

    if (tools.length > 0) {
      logger.info({ toolCount: tools.length }, "✅ SDK docs proxy initialized");
      return true;
    }
    logger.warn("⚠️ SDK docs returned 0 tools");
  } catch (error) {
    logger.warn({ err: error, attempt }, "SDK docs proxy attempt failed");
  }

  // Retry if we haven't exceeded max attempts
  if (retryCount < MAX_DOCS_RETRIES - 1) {
    logger.info({ delayMs: DOCS_RETRY_DELAY }, "Retrying SDK docs proxy init");
    await new Promise(resolve => setTimeout(resolve, DOCS_RETRY_DELAY));
    return warmDocsCache(retryCount + 1);
  }

  logger.warn({ maxAttempts: MAX_DOCS_RETRIES }, "⚠️ SDK docs proxy unavailable. Meta-tools still available.");
  // Alert loudly: a dead docs proxy silently degrades conceptual answers (see
  // the Mintlify migration incident). Best-effort — no-op if Discord isn't set.
  void notifyError(
    "SDK docs proxy unavailable at startup",
    new Error(
      `docs MCP (https://docs.sodax.com/mcp) returned no tools after ${MAX_DOCS_RETRIES} attempts. docs_* documentation tools are NOT registered; conceptual 'is X supported?' answers may regress.`,
    ),
  );
  return false;
}

async function runStdio(swapToolsEnabled: boolean): Promise<void> {
  const apiKey = parseApiKey(process.env.SODAX_API_KEY);
  const keyStatus = apiKeyStatus(process.env.SODAX_API_KEY);
  if (keyStatus === "malformed") logger.warn("SODAX_API_KEY is not a SODAX API key (sodax_…); calls go out keyless");
  // Before the docs warm-up, so a refused profile or partner fee fails fast.
  const toolsets = selectToolsets(profileFromArgs(process.argv.slice(2), process.env), {
    apiKey: keyStatus,
    swapToolsEnabled,
  });
  const partnerFee = partnerFeeFromEnv(process.env);

  // Warm SDK docs cache before creating server
  logger.info("Initializing SODAX docs proxy...");
  await warmDocsCache();

  setFallbackRequestContext({ apiKey, partnerFee });
  const server = await createServer(toolsets);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SODAX Builders MCP server running via stdio");
}

async function runHTTP(swapToolsEnabled: boolean): Promise<void> {
  if (profileFromArgs(process.argv.slice(2), process.env) !== undefined) {
    logger.warn(
      "--profile and MCP_PROFILE are ignored over HTTP: each client picks its profile with ?profile= or x-sodax-profile",
    );
  }
  if (process.env.SODAX_API_KEY) {
    logger.warn("SODAX_API_KEY is ignored over HTTP: each client sends its own x-api-key");
  }
  if (process.env.SODAX_PARTNER_FEE_ADDRESS || process.env.SODAX_PARTNER_FEE_BPS) {
    logger.warn("SODAX_PARTNER_FEE_* is ignored over HTTP: each client sets its own partner fee");
  }

  // Warm SDK docs cache before starting HTTP server
  logger.info("Initializing SODAX docs proxy...");
  await warmDocsCache();

  // The swap tools only count while the rollout switch is on.
  seedToolRegistry({ builder: true, swap: swapToolsEnabled });

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
    // expired SDK docs cache can't stall the landing page on a 30s fetch — it
    // renders with the cached (or meta-only) count instead.
    const sdkDocsToolCount = getCachedDocsToolNames().length;
    res.type("html").send(renderLandingPage(landingTemplate, { networks, sdkDocsToolCount }));
  };

  app.get("/", serveLandingPage);
  app.get("/index.html", serveLandingPage);

  app.use(express.static(join(__dirname, "public")));

  app.get("/health", async (_req: Request, res: Response) => {
    // Non-blocking: read SDK docs health/tool counts from the warmed cache so a
    // cold or expired cache can't stall the health check on a 30s SDK docs fetch
    // (orchestrators treat a slow /health as unhealthy). warmDocsCache() and
    // per-request servers keep the cache fresh; docs_health does the live probe.
    const docsHealth = getCachedDocsHealth();
    const docsToolNames = getCachedDocsToolNames();
    // Per-group breakdown derived from the tool registry. `api` covers backend
    // + solver tools; `relay` the intent-relay tools; `swap` the swap profile;
    // `sdkDocs` the dynamic SDK docs proxy.
    const staticToolCounts = getStaticToolCounts();
    const sdkDocsToolCount = docsToolNames.length;
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
        total: staticToolCounts.total + sdkDocsToolCount,
        api: staticToolCounts.api,
        relay: staticToolCounts.relay,
        swap: staticToolCounts.swap,
        sdkDocs: sdkDocsToolCount,
      },
      sdkDocsProxy: {
        healthy: docsHealth.healthy,
        toolCount: docsHealth.toolCount,
      },
    });
  });

  app.all("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    const connection = resolveConnection(req, res, swapToolsEnabled);
    if (!connection) return;
    const clientId = hashClientIp(req.ip || "unknown");
    const requestServer = await createServer(connection.toolsets, clientId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await requestServer.connect(transport);
    await runWithRequestContext(connection.context, () => transport.handleRequest(req, res, req.body));
  });

  // Legacy SSE transport for clients that don't support streamable HTTP (e.g. Gemini CLI)
  // context: from GET /sse (tool set, partner fee); each POST /messages runs with its own key only.
  const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer; context: RequestContext }>();

  app.get("/sse", mcpLimiter, async (req: Request, res: Response) => {
    const connection = resolveConnection(req, res, swapToolsEnabled);
    if (!connection) return;
    const clientId = hashClientIp(req.ip || "unknown");
    const sseServer = await createServer(connection.toolsets, clientId);
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, { transport, server: sseServer, context: connection.context });

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
    // This POST's own x-api-key only, as on /mcp: the sessionId in the URL is no credential.
    const context = { ...session.context, apiKey: callerApiKey(req) };
    await runWithRequestContext(context, () => session.transport.handlePostMessage(req, res, req.body));
  });

  app.get("/api", async (_req: Request, res: Response) => {
    // Non-blocking: docs tool list from the warmed cache (see /health) so a cold
    // or expired SDK docs cache can't stall the response on a 30s fetch.
    const docsTools = getCachedDocsToolNames();
    // Current proxy health, so recovery after startup (a later request or
    // docs_refresh) and a failed refresh after a good start are both reflected.
    const docsConnected = getCachedDocsHealth().healthy;

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
      profiles: {
        default: "all",
        select: "?profile=<name> or the x-sodax-profile header",
        ...describeProfiles(swapToolsEnabled),
      },
      // Tool lists derived from the tool registry; sdkDocs reflects the live
      // SDK docs proxy list.
      tools: {
        ...getToolNamesByModule(),
        sdkDocs: docsTools,
      },
      sdkDocsProxy: {
        source: "https://docs.sodax.com/mcp",
        description: "SDK documentation tools are proxied from docs.sodax.com (Mintlify) and update automatically",
        status: docsConnected ? "connected" : "unavailable",
        initAttempts: docsInitAttempts,
        hint: docsConnected
          ? "docs_* tools are ready to use"
          : "Use docs_list_tools or docs_refresh to check availability",
      },
    });
  });

  const port = Number.parseInt(process.env.PORT || "3000");
  app.listen(port, "0.0.0.0", () => {
    logger.info(
      { port, sodaxEnv: SODAX_ENV, swapToolsEnabled },
      `SODAX Builders MCP server running on http://0.0.0.0:${port}`,
    );
    // #38: announce the server is online to Discord (silent when no webhook set).
    void notifyServerStarted({
      version: SERVER_VERSION,
      transport: "http",
      port,
      env: process.env.NODE_ENV || "unset",
      sodaxEnv: SODAX_ENV,
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
  if (SODAX_ENV_ERROR) throw new Error(SODAX_ENV_ERROR);
  const swapToolsEnabled = parseSwapToolsEnabled(process.env.SODAX_SWAP_TOOLS_ENABLED);
  const transport = process.env.TRANSPORT || "http";
  if (transport === "stdio") {
    await runStdio(swapToolsEnabled);
  } else {
    await runHTTP(swapToolsEnabled);
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
