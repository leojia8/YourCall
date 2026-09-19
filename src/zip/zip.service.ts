import { PurchaseRequest, ProposedAction, ActionResult } from "../types";
import { ZipRequest, ZipRequestListResponse } from "./zip.types";
import { mapZipRequest } from "./zip.mapper";

const ZIP_API_URL = process.env.ZIP_API_URL;
const ZIP_API_KEY = process.env.ZIP_API_KEY;
const ZIP_USER_ID = process.env.ZIP_USER_ID;
const ZIP_USER_NAME = process.env.ZIP_USER_NAME;

function getHeaders(): Record<string, string> {
  if (!ZIP_API_KEY) {
    throw new Error("ZIP_API_KEY is not configured");
  }

  return {
    "Zip-Api-Key": ZIP_API_KEY,
    "Content-Type": "application/json",
  };
}

export async function getPendingRequests(): Promise<PurchaseRequest[]> {
  if (!ZIP_API_URL) {
    throw new Error("ZIP_API_URL is not configured");
  }

  const response = await fetch(`${ZIP_API_URL}/requests`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Zip API error: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as ZipRequestListResponse;

  return data.list
    .filter((request) => request.request_type === "PURCHASE_REQUEST")
    .map(mapZipRequest);
}

export async function getRequestById(
  id: string
): Promise<PurchaseRequest | null> {
  if (!ZIP_API_URL) {
    throw new Error("ZIP_API_URL is not configured");
  }

  const response = await fetch(`${ZIP_API_URL}/requests/${id}`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Zip API error: ${response.status} ${response.statusText}`
    );
  }

  const request = (await response.json()) as ZipRequest;

  return mapZipRequest(request);
}

async function recordAuthorization(
  requestId: string
): Promise<void> {
  if (!ZIP_API_URL) {
    throw new Error("ZIP_API_URL is not configured");
  }

  if (!ZIP_USER_ID || !ZIP_USER_NAME) {
    throw new Error("ZIP_USER_ID or ZIP_USER_NAME is not configured");
  }

  const response = await fetch(`${ZIP_API_URL}/comments`, {
    method: "POST",
    headers: {
      ...getHeaders(),
      "Zip-Api-Version": "2024-06-06",
    },
    body: JSON.stringify({
      data: {
        text: "Authorized via YourCall after user confirmation.",
        user_id: ZIP_USER_ID,
        external_display_name: ZIP_USER_NAME,
        purchase_requisition_id: requestId,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Zip API error: ${response.status} ${response.statusText}`
    );
  }
}

async function rejectRequest(
  requestId: string
): Promise<void> {
  if (!ZIP_API_URL) {
    throw new Error("ZIP_API_URL is not configured");
  }

  const response = await fetch(
    `${ZIP_API_URL}/requests/${requestId}/status`,
    {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify({
        data: {
          status: "REJECTED",
          reason: "NOT_ENOUGH_BUDGET",
          other_reason: "Rejected via YourCall",
          reason_explanation:
            "Request rejected through YourCall after user confirmation.",
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Zip API error: ${response.status} ${response.statusText}`
    );
  }
}

export async function executeAction(
  action: ProposedAction
): Promise<ActionResult> {
  try {
    if (action.type === "APPROVE") {
        await recordAuthorization(action.requestId);

        return {
            requestId: action.requestId,
            action: action.type,
            success: true,
        };
    }

    if (action.type === "DENY") {
        await rejectRequest(action.requestId);

        return {
            requestId: action.requestId,
            action: action.type,
            success: true,
        };
    }

    return {
      requestId: action.requestId,
      action: action.type,
      success: false,
      error: `${action.type} is not implemented yet`,
    };
  } catch (error) {
    return {
      requestId: action.requestId,
      action: action.type,
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown Zip API error",
    };
  }
}