// reflects the raw json from zip

export interface ZipEntityRef {
  id: string;
  name: string;
}

export interface ZipVendor {
  id: string;
  type: string;
  name: string;
}

export interface ZipUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
}

export interface ZipLineItem {
  id: string;
  description: string;
  quantity: string;
  rate: string;
  total: string;
  currency: string;
  line_type_name: string;
}

export interface ZipPriceDetail {
  id: string;
  total: string;
  currency: string;
  line_items: ZipLineItem[];
}

export interface ZipPurchaseOrder {
  id: string;
  po_number: string;
  external_id: string | null;
}

export interface ZipRequest {
  id: string;
  request_number: number | null;
  request_type: string;

  name: string | null;
  description: string | null;

  subsidiary: ZipEntityRef | null;
  department: ZipEntityRef | null;

  vendor: ZipVendor | null;

  category: ZipEntityRef | null;
  subcategory: ZipEntityRef | null;

  requester: ZipUser | null;

  purchase_order: ZipPurchaseOrder | null;

  status: number;
  priority: number;

  price_detail: ZipPriceDetail | null;

  amount_usd: string | null;
  payment_method: string;
  is_existing_vendor: boolean | null;

  created_at: number;
  updated_at: number;
}

export interface ZipRequestListResponse {
  list: ZipRequest[];
  size: number;
  total: number;
}