#!/usr/bin/env node
/**
 * SODAX Builders MCP Server
 *
 * Live API data for developers and integration partners.
 * Data fetched live from api.sodax.com.
 * SDK documentation proxied from docs.sodax.com/mcp.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClientNotificationSchema, ClientRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { messageContext, resolveConnection } from "./connection.js";
import { SODAX_ENV, SODAX_ENV_ERROR, SWAP_USD_WARN_ERROR } from "./constants.js";
import { SERVER_VERSION, createServer, seedToolRegistry } from "./server.js";
import { CLIENT_ID_KEYED, hashClientIp, shutdownAnalytics } from "./services/analytics.js";
import { checkApiDrift } from "./services/apiDriftCheck.js";
import { notifyError, notifyServerStarted, notifyServerStopping } from "./services/discord.js";
import { fetchDocsTools, getCachedDocsHealth } from "./services/docsProxy.js";
import {
  type SseLease,
  SseSessionLimiter,
  asyncHandler,
  createMcpLimiter,
  jsonErrorHandler,
  limitBody,
  mcpGetNotAllowed,
  rateLimitHandler,
  requestRoute,
} from "./services/httpGuards.js";
import { formatNetworkCount, renderLandingPage } from "./services/landingPage.js";
import { logger } from "./services/logger.js";
import type { OtelLogs } from "./services/otel.js";
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
  getRequestContext,
  parseApiKey,
  runWithRequestContext,
  setFallbackRequestContext,
} from "./services/requestContext.js";
import { type RpcOverride, initSodax, parseRpcOverrides } from "./services/sodax.js";
import { getIntegratedNetworksCount } from "./services/sodaxApi.js";
import { openQuotes } from "./services/swap/quoteCache.js";
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

/** `rpcOverrides`: the RPC overrides the swap tools read through, already checked. */
async function runStdio(rpcOverrides: Record<string, RpcOverride>, swapToolsEnabled: boolean): Promise<void> {
  const apiKey = parseApiKey(process.env.SODAX_API_KEY);
  const keyStatus = apiKeyStatus(process.env.SODAX_API_KEY);
  if (keyStatus === "malformed") logger.warn("SODAX_API_KEY is not a SODAX API key (sodax_…); calls go out keyless");
  // Before the docs warm-up, so a refused profile or partner fee fails fast.
  const toolsets = selectToolsets(profileFromArgs(process.argv.slice(2), process.env), {
    apiKey: keyStatus,
    swapToolsEnabled,
  });
  // The SDK only for the swap tools, and before the partner fee: its checksum check needs it.
  if (toolsets.swap) await initSodax(rpcOverrides);
  const partnerFee = partnerFeeFromEnv(process.env);

  // Warm SDK docs cache before creating server; a swap-only server has no docs tools.
  if (toolsets.builder) {
    logger.info("Initializing SODAX docs proxy...");
    await warmDocsCache();
  }

  setFallbackRequestContext({ apiKey, partnerFee });
  const server = await createServer(toolsets);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SODAX Builders MCP server running via stdio");
}

async function runHTTP(rpcOverrides: Record<string, RpcOverride>, swapToolsEnabled: boolean): Promise<void> {
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
  // Warm the SDK docs cache, and load the SDK while the swap tools are on: any keyed connection can get them.
  logger.info("Initializing SODAX docs proxy...");
  await Promise.all([swapToolsEnabled ? initSodax(rpcOverrides) : undefined, warmDocsCache()]);

  seedToolRegistry({ builder: true, swap: swapToolsEnabled });

  listen(createHttpApp(swapToolsEnabled), swapToolsEnabled);
}

// The methods a client sends, from the SDK's own schemas: anything else is "other", so a client can't shape the record.
const MCP_METHODS = new Set<string>(
  [...ClientRequestSchema.options, ...ClientNotificationSchema.options].map(schema => schema.shape.method.value),
);

/** What the client asked for: a protocol method, "batch" for an array, "other" for any other body; none when nothing was parsed. */
function mcpMethod(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (Array.isArray(body)) return "batch";
  const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
  return typeof method === "string" && MCP_METHODS.has(method) ? method : "other";
}

/**
 * One "HTTP request" record per MCP request (#110), the ones a guard refuses included, and the request id every
 * other record of the request carries: the context opens here and the handlers extend it with the connection's.
 * On GET /sse the record is the session's: 200 and its length. Not for /health and the pages.
 */
function logMcpRequests(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const clientId = hashClientIp(req.ip || "unknown");
  const started = Date.now();
  // "close" follows "finish", and comes alone when the client went away first; it may run outside the context.
  res.once("close", () => {
    const status = res.statusCode;
    // A limiter logs its refusals once per window (rateLimitHandler); one record each would let a flood write the log.
    logger[status === 429 ? "debug" : "info"](
      {
        "request.id": requestId,
        "http.request.method": req.method,
        "http.route": requestRoute(req),
        // None when the client left before the answer.
        "http.response.status_code": res.headersSent ? status : undefined,
        "duration.ms": Date.now() - started,
        "mcp.method.name": mcpMethod(req.body),
        "client.ip_hash": CLIENT_ID_KEYED ? clientId : undefined,
      },
      "HTTP request",
    );
  });
  // The id a builder can quote when reporting a problem; every record of the request carries it.
  res.setHeader("X-Request-Id", requestId);
  runWithRequestContext({ requestId, clientId }, next);
}

/** The routes and their guards, without the docs warm-up or a listener, so a test can serve them. */
export function createHttpApp(swapToolsEnabled: boolean): Express {
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

  // Before the limiters: a refused request is a request too. Routed, so /MCP and /mcp/ count like the handlers do.
  app.all(["/mcp", "/messages", "/sse"], logMcpRequests);

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler(limitBody("Too many requests, please try again later.")),
  });
  app.use(limiter);

  // Stricter rate limit for MCP endpoints (60 per minute; a batch on /mcp counts per message)
  const mcpLimiter = createMcpLimiter();

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
      // In memory: a deploy waits for open to reach 0 (README, Operating the swap tools).
      swapQuotes: openQuotes(),
      unifiedLogging: otel ? { on: true, ...otel.stats() } : { on: false },
    });
  });

  app.get("/mcp", mcpGetNotAllowed);

  app.all(
    "/mcp",
    mcpLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const connection = resolveConnection(req, res, swapToolsEnabled);
      if (!connection) return;
      const requestServer = await createServer(connection.toolsets, getRequestContext().clientId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await requestServer.connect(transport);
      // The request's context (logMcpRequests) plus the connection's: one id on every record (#110).
      await runWithRequestContext({ ...getRequestContext(), ...connection.context }, () =>
        transport.handleRequest(req, res, req.body),
      );
    }),
  );

  // Legacy SSE transport for clients that don't support streamable HTTP (e.g. Gemini CLI)
  const sseLimiter = new SseSessionLimiter();
  // context: from GET /sse (tool set, partner fee); each POST /messages runs with its own key only.
  const sseSessions = new Map<
    string,
    { transport: SSEServerTransport; server: McpServer; context: RequestContext; lease: SseLease }
  >();

  app.get(
    "/sse",
    mcpLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      // Before taking a slot, so a refused connection never holds one.
      const connection = resolveConnection(req, res, swapToolsEnabled);
      if (!connection) return;
      const ip = req.ip || "unknown";
      // An idle session ends its stream; the close handlers below clean up.
      const lease = sseLimiter.open(ip, () => res.end());
      if (!lease) {
        res.status(429).json({ error: "Too many open SSE sessions. Close one, or use /mcp." });
        return;
      }
      let closed = false;
      res.on("close", () => {
        closed = true;
        lease.release();
      });

      const sseServer = await createServer(connection.toolsets, getRequestContext().clientId);
      if (closed) return;
      const transport = new SSEServerTransport("/messages", res);
      sseSessions.set(transport.sessionId, { transport, server: sseServer, context: connection.context, lease });

      res.on("close", () => {
        sseSessions.delete(transport.sessionId);
        transport.close();
      });

      // connect() starts the transport; a second start() throws.
      await sseServer.connect(transport);
    }),
  );

  app.post(
    "/messages",
    mcpLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      const session = sseSessions.get(sessionId);
      if (!session) {
        res.status(400).json({ error: "Invalid or expired session. Reconnect via GET /sse." });
        return;
      }
      // This POST's own x-api-key only, as on /mcp: the sessionId in the URL is no credential.
      const context = messageContext(session.context, req, res);
      if (!context) return;
      session.lease.touch();
      await runWithRequestContext({ ...getRequestContext(), ...context }, () =>
        session.transport.handlePostMessage(req, res, req.body),
      );
    }),
  );

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
      description: `Live cross-network DeFi API data, AMM analytics, money market insights, ${swapToolsEnabled ? "swap tools, " : ""}and auto-updating SDK docs for ${formatNetworkCount(networks)} networks`,
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

  // Last: malformed or oversized bodies and unexpected errors get a JSON body.
  app.use(jsonErrorHandler);
  return app;
}

function listen(app: Express, swapToolsEnabled: boolean): void {
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

let otel: OtelLogs | undefined;

async function main(): Promise<void> {
  // The OTLP destination (#110) and its SDK load only when asked for; first, so a config error below ships too.
  if (process.env.OTEL_LOGS_ENABLED === "true") {
    try {
      const { startOtelLogs } = await import("./services/otel.js");
      otel = startOtelLogs(process.env, { serviceVersion: SERVER_VERSION, instanceId: process.env.HOSTNAME });
    } catch (error) {
      // An optional destination: if it can't start, the logs stay on stderr and the server still serves.
      logger.warn({ err: error }, "Unified logging stays off");
    }
  }
  if (SODAX_ENV_ERROR) throw new Error(SODAX_ENV_ERROR);
  if (SWAP_USD_WARN_ERROR) throw new Error(SWAP_USD_WARN_ERROR);
  const swapToolsEnabled = parseSwapToolsEnabled(process.env.SODAX_SWAP_TOOLS_ENABLED);
  const rpcOverrides = parseRpcOverrides(process.env);
  const transport = process.env.TRANSPORT || "http";
  if (transport === "stdio") {
    await runStdio(rpcOverrides, swapToolsEnabled);
  } else {
    await runHTTP(rpcOverrides, swapToolsEnabled);
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
  const open = openQuotes().open;
  const alert = open > 0 ? `${context} (${open} open swap quote(s) lost)` : context;
  void notifyError(alert, error).finally(() => {
    const force = setTimeout(() => process.exit(1), 1000);
    logger.flush(() => {
      // What the OTLP batch still holds; a stuck export is cut by the force timer.
      void Promise.resolve(otel?.forceFlush())
        .catch(() => {})
        .finally(() => {
          clearTimeout(force);
          process.exit(1);
        });
    });
  });
}

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
  await notifyServerStopping(signal, openQuotes().open);
  await shutdownAnalytics();
  // A failing export rejects the shutdown; the exit must still happen.
  await Promise.race([otel?.shutdown().catch(() => {}), sleep(2000, undefined, { ref: false })]);
  process.exit(0);
}

/** Run as a script (node, tsx), not imported by a test. Resolved as node does, so `node .` counts too. */
function isEntryPoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(createRequire(import.meta.url).resolve(process.argv[1])) === __filename;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => fatalExit("Server failed to start", error));

  // #38: surface unexpected runtime failures to Discord, then exit — preserving
  // Node's default crash semantics for uncaught errors / unhandled rejections.
  process.on("uncaughtException", error => fatalExit("Uncaught exception", error));
  process.on("unhandledRejection", reason => fatalExit("Unhandled promise rejection", reason));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}
