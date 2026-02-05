/**
 * GitBook MCP Proxy Tools
 * 
 * Dynamically registers tools from the GitBook MCP server
 * and proxies requests to it for live SDK documentation access.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchGitBookTools,
  callGitBookTool,
  checkGitBookHealth,
  clearGitBookCache,
  GitBookTool
} from "../services/gitbookProxy.js";

/**
 * Convert GitBook tool input schema to Zod schema
 */
function convertToZodSchema(inputSchema: GitBookTool["inputSchema"]): z.ZodTypeAny {
  if (!inputSchema.properties || Object.keys(inputSchema.properties).length === 0) {
    return z.object({});
  }
  
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = inputSchema.required || [];
  
  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    const propDef = prop as { type?: string; description?: string; default?: unknown };
    let fieldSchema: z.ZodTypeAny;
    
    switch (propDef.type) {
      case "string":
        fieldSchema = z.string();
        break;
      case "number":
      case "integer":
        fieldSchema = z.number();
        break;
      case "boolean":
        fieldSchema = z.boolean();
        break;
      case "array":
        fieldSchema = z.array(z.unknown());
        break;
      case "object":
        fieldSchema = z.record(z.unknown());
        break;
      default:
        fieldSchema = z.unknown();
    }
    
    // Add description if available
    if (propDef.description) {
      fieldSchema = fieldSchema.describe(propDef.description);
    }
    
    // Make optional if not required
    if (!required.includes(key)) {
      fieldSchema = fieldSchema.optional();
    }
    
    shape[key] = fieldSchema;
  }
  
  return z.object(shape);
}

// Track if meta-tools have been registered (only once per server instance)
let metaToolsRegistered = false;

/**
 * Register GitBook MCP tools as proxied tools in our server
 */
export async function registerGitBookProxyTools(server: McpServer): Promise<number> {
  let registeredCount = 0;
  
  // Register meta tools only once (they work even if GitBook is down)
  if (!metaToolsRegistered) {
    registerGitBookMetaTools(server);
    metaToolsRegistered = true;
  }
  
  try {
    const tools = await fetchGitBookTools();
    
    if (tools.length === 0) {
      console.error("No tools found from GitBook MCP - meta-tools registered, proxy tools skipped");
      return 0;
    }
    
    console.error(`Registering ${tools.length} GitBook tools as docs_* proxies...`);
    
    for (const tool of tools) {
      try {
        // Prefix with "docs_" to indicate these are from SDK docs
        const proxyToolName = `docs_${tool.name}`;
        const zodSchema = convertToZodSchema(tool.inputSchema);
        
        server.tool(
          proxyToolName,
          `[SDK Docs] ${tool.description}`,
          zodSchema._def.typeName === "ZodObject" 
            ? (zodSchema as z.ZodObject<z.ZodRawShape>).shape 
            : {},
          async (args) => {
            const result = await callGitBookTool(tool.name, args as Record<string, unknown>);
            
            // Add helpful context if the call failed
            if (result.isError) {
              return {
                content: [{
                  type: "text" as const,
                  text: `⚠️ docs_${tool.name} failed: ${result.content[0]?.text || "Unknown error"}\n\nTry docs_refresh to reconnect, or visit https://docs.sodax.com directly.`
                }],
                isError: true
              };
            }
            
            return {
              content: result.content.map(c => ({
                type: c.type as "text",
                text: c.text || JSON.stringify(c)
              })),
              isError: result.isError
            };
          }
        );
        
        registeredCount++;
      } catch (toolError) {
        console.error(`Failed to register GitBook tool ${tool.name}:`, toolError);
      }
    }
    
    console.error(`Registered ${registeredCount} tools from GitBook MCP`);
  } catch (error) {
    console.error("Failed to register GitBook proxy tools:", error);
  }
  
  return registeredCount;
}

/**
 * Register meta tools for managing GitBook MCP connection
 */
function registerGitBookMetaTools(server: McpServer): void {
  // Tool to check GitBook MCP health
  server.tool(
    "docs_health",
    "Check SDK documentation availability. Call this first if docs tools seem unavailable.",
    {},
    async () => {
      const health = await checkGitBookHealth();
      const tools = await fetchGitBookTools();
      
      if (health.healthy && tools.length > 0) {
        const toolNames = tools.slice(0, 5).map(t => `docs_${t.name}`).join(", ");
        return {
          content: [{
            type: "text",
            text: `✅ SDK Docs available. ${health.toolCount} tools ready.\n\nExample tools: ${toolNames}${tools.length > 5 ? "..." : ""}\n\nUse docs_list_tools for the full list, or call any docs_* tool directly.`
          }]
        };
      }
      
      return {
        content: [{
          type: "text",
          text: `⚠️ SDK Docs temporarily unavailable.\n\n**What you can do:**\n1. Try \`docs_refresh\` to reconnect\n2. Visit https://docs.sodax.com directly\n3. Use SODAX API tools (sodax_*) which work independently`
        }]
      };
    }
  );
  
  // Tool to refresh GitBook tools
  server.tool(
    "docs_refresh",
    "Reconnect to SDK documentation and refresh available tools. Use if docs seem stale or unavailable.",
    {},
    async () => {
      clearGitBookCache();
      const tools = await fetchGitBookTools();
      
      if (tools.length === 0) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Could not connect to docs.sodax.com\n\nThe GitBook MCP may be temporarily unavailable. Try again later or visit https://docs.sodax.com directly.`
          }]
        };
      }
      
      const toolList = tools.map(t => `- \`docs_${t.name}\`: ${t.description}`).join("\n");
      return {
        content: [{
          type: "text",
          text: `✅ Refreshed. ${tools.length} SDK documentation tools available:\n\n${toolList}`
        }]
      };
    }
  );
  
  // Tool to list available docs tools with full details
  server.tool(
    "docs_list_tools",
    "List all SDK documentation tools with parameters. Essential for discovering what's available.",
    {},
    async () => {
      const tools = await fetchGitBookTools();
      if (tools.length === 0) {
        return {
          content: [{
            type: "text",
            text: `⚠️ No SDK documentation tools available.\n\n**Troubleshooting:**\n1. Run \`docs_refresh\` to reconnect\n2. Check \`docs_health\` for status\n3. The GitBook MCP at docs.sodax.com may be temporarily down\n\n**Alternative:** SODAX API tools (sodax_*) work independently.`
          }]
        };
      }
      
      const toolList = tools.map(t => {
        const params = t.inputSchema.properties 
          ? Object.entries(t.inputSchema.properties).map(([k, v]) => {
              const prop = v as { type?: string; description?: string };
              const required = t.inputSchema.required?.includes(k) ? " (required)" : "";
              return `  - \`${k}\`: ${prop.type || "any"}${required}${prop.description ? ` — ${prop.description}` : ""}`;
            }).join("\n")
          : "  (no parameters)";
        return `### \`docs_${t.name}\`\n${t.description}\n\n**Parameters:**\n${params}`;
      }).join("\n\n---\n\n");
      
      return {
        content: [{
          type: "text",
          text: `# SDK Documentation Tools\n\n${tools.length} tools from docs.sodax.com:\n\n---\n\n${toolList}`
        }]
      };
    }
  );
}

/**
 * Get list of registered GitBook tool names for API response
 */
export async function getGitBookToolNames(): Promise<string[]> {
  try {
    const tools = await fetchGitBookTools();
    const proxyTools = tools.map(t => `docs_${t.name}`);
    return [...proxyTools, "docs_health", "docs_refresh", "docs_list_tools"];
  } catch {
    return ["docs_health", "docs_refresh", "docs_list_tools"];
  }
}
