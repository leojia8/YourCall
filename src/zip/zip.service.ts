import { PurchaseRequest, ProposedAction, ActionResult } from "../types";
import { ZipRequestListResponse } from "./zip.types";
import { mapZipRequest } from "./zip.mapper";

const ZIP_API_URL = process.env.ZIP_API_URL;
const ZIP_API_KEY = process.env.ZIP_API_KEY;

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
  // We'll implement this after getPendingRequests is verified.
  return null;
}

export async function executeAction(
  action: ProposedAction
): Promise<ActionResult> {
  // IMPORTANT: no Zip writes until we verify the exact API endpoint.
  return {
    requestId: action.requestId,
    action: action.type,
    success: false,
    error: "Zip write actions not implemented yet",
  };
}