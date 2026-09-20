import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "uv",
    args: ["run", "--with", "ziphq-mcp", "ziphq-mcp"],
    env: {
      ...process.env,
      ZIP_MCP_MODE: "readonly",
    },
  });

  const client = new Client({
    name: "yourcall-mcp-test",
    version: "0.1.0",
  });

  await client.connect(transport);

  // Our real Lemongrass request
  const requestId = "10cbc01e-ec9a-8500-89a0-1e8908b98ed6";

  console.log("\n=== REQUEST ===");

  const request = await client.callTool({
    name: "zip_get_request",
    arguments: {
      request_id: requestId,
    },
  });

  console.dir(request, { depth: null });

  console.log("\n=== APPROVALS ===");

  // Lemongrass is Zip request #2.
  // zip_search_approvals expects the request NUMBER, not the UUID.
  const approvals = await client.callTool({
    name: "zip_search_approvals",
    arguments: {
      request_number: 2,
    },
  });

  console.dir(approvals, { depth: null });

  await client.close();
}

main().catch(console.error);