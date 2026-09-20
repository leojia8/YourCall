import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;

  const transport = new StdioClientTransport({
    command: "uv",
    args: ["run", "--with", "ziphq-mcp", "ziphq-mcp"],
    env: {
      ...process.env,
      ZIP_MCP_MODE: "readonly",
    },
  });

  client = new Client({
    name: "yourcall",
    version: "0.1.0",
  });

  await client.connect(transport);
  return client;
}

function parseToolResult(result: any): any {
  const text = result.content?.find(
    (item: any) => item.type === "text"
  )?.text;

  if (!text) {
    throw new Error("Zip MCP returned no text content");
  }

  return JSON.parse(text);
}

export async function getZipRequestContext(requestId: string) {
  const mcp = await getClient();

  const result = await mcp.callTool({
    name: "zip_get_request",
    arguments: {
      request_id: requestId,
    },
  });

  if (result.isError) {
    throw new Error("Failed to retrieve Zip request through MCP");
  }

  return parseToolResult(result);
}

export async function getZipApprovalContext(requestNumber: number) {
  const mcp = await getClient();

  const result = await mcp.callTool({
    name: "zip_search_approvals",
    arguments: {
      request_number: requestNumber,
    },
  });

  if (result.isError) {
    throw new Error("Failed to retrieve Zip approvals through MCP");
  }

  return parseToolResult(result);
}