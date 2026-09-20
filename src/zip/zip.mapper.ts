// mapping zip object into the clean PurchaseRequest type the rest of YourCall understands

import { PurchaseRequest } from "../types";
import { ZipRequest } from "./zip.types";

export function mapZipRequest(
  request: ZipRequest
): PurchaseRequest {
  return {
    id: request.id,

    vendor: {
      id: request.vendor?.id,
      name: request.vendor?.name ?? "Unknown vendor",
    },

    amount: request.amount_usd
      ? Number(request.amount_usd)
      : 0,

    currency: request.price_detail?.currency ?? "USD",

    status: String(request.status),

    existingVendor:
      request.is_existing_vendor ?? undefined,

    category: request.category?.name,

    requester: request.requester
      ? {
          id: request.requester.id,
          name: `${request.requester.first_name} ${request.requester.last_name}`.trim(),
        }
      : undefined,

    createdAt: request.created_at
      ? new Date(request.created_at * 1000).toISOString()
      : undefined,
  };
}