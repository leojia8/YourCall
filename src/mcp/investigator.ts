import {
  getZipRequestContext,
  getZipApprovalContext,
} from "./zip.mcp";

export interface ZipInvestigation {
  request: any;
  approvals: any;
}

function getRequestNumber(request: any): number {
  // Zip MCP's request response contains request_number.
  const requestNumber = request.request_number;

  if (typeof requestNumber !== "number") {
    throw new Error("Zip MCP request did not contain a request_number");
  }

  return requestNumber;
}

export async function investigateZipRequest(
  requestId: string
): Promise<ZipInvestigation> {
  // Get the richer request context through MCP.
  const request = await getZipRequestContext(requestId);

  // Approvals are searched using Zip's human-facing request number,
  // rather than the request UUID.
  const requestNumber = getRequestNumber(request);

  const approvals = await getZipApprovalContext(requestNumber);

  return {
    request,
    approvals,
  };
}