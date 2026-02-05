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

/**
 * Register GitBook MCP tools as proxied tools in our server
 */
export async function registerGitBookProxyTools(server: McpServer): Promise<number> {
  let registeredCount = 0;
  
  try {
    const tools = await fetchGitBookTools();
    
    if (tools.length === 0) {
      console.error("No tools found from GitBook MCP, skipping proxy registration");
      return 0;
    }
    
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
  
  // Always register meta tools for managing the GitBook connection
  registerGitBookMetaTools(server);
  
  return registeredCount;
}

/**
 * Register meta tools for managing GitBook MCP connection
 */
function registerGitBookMetaTools(server: McpServer): void {
  // Tool to check GitBook MCP health
  server.tool(
    "docs_health",
    "Check the health and availability of the SDK documentation MCP server",
    {},
    async () => {
      const health = await checkGitBookHealth();
      return {
        content: [{
          type: "text",
          text: health.healthy
            ? `✅ SDK Docs MCP is healthy. ${health.toolCount} documentation tools available.`
            : `❌ SDK Docs MCP is not reachable. Documentation tools may be unavailable.`
        }]
      };
    }
  );
  
  // Tool to refresh GitBook tools
  server.tool(
    "docs_refresh",
    "Refresh the list of available SDK documentation tools from GitBook",
    {},
    async () => {
      clearGitBookCache();
      const tools = await fetchGitBookTools();
      return {
        content: [{
          type: "text",
          text: `Refreshed GitBook tools. ${tools.length} documentation tools available:\n\n` +
            tools.map(t => `- **docs_${t.name}**: ${t.description}`).join("\n")
        }]
      };
    }
  );
  
  // Tool to list available docs tools
  server.tool(
    "docs_list_tools",
    "List all available SDK documentation tools from the GitBook MCP",
    {},
    async () => {
      const tools = await fetchGitBookTools();
      if (tools.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No SDK documentation tools available. The GitBook MCP may be unreachable."
          }]
        };
      }
      
      const toolList = tools.map(t => {
        const params = t.inputSchema.properties 
          ? Object.keys(t.inputSchema.properties).join(", ") 
          : "none";
        return `### docs_${t.name}\n${t.description}\n**Parameters:** ${params}`;
      }).join("\n\n");
      
      return {
        content: [{
          type: "text",
          text: `# SDK Documentation Tools\n\n${tools.length} tools available from docs.sodax.com:\n\n${toolList}`
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
