import type { Currency, CountryCode } from "./commerce-currency";
import type { ContentTranslations } from "./content";
export interface Merchant {
  shipping_rules?: import("./shipping-zones").ShippingRule[];
  shipping_rules_enabled?: boolean;
  shipping_zones?: boolean;
  country_code?: CountryCode;
  currency?: Currency;
  currency_locked?: boolean;
  regional_enabled?: boolean;
  plan?: "free" | "pro";
  bookkeeping_enabled?: boolean;
  subscription_access?: boolean;
  trial_ends_at?: string;
  content_translations?: ContentTranslations;
  id: number;
  name: string;
  slug: string;
  email?: string;
  phone: string;
  description: string;
  logo?: string;
  banner?: string;
  role?: string;
  is_admin?: number;
  member_name?: string;
  shipping_fee?: number;
  courier?: string;
}
export interface Product {
  unit_cost?: number | null;
  content_translations?: ContentTranslations;
  id: number;
  merchant_id?: number;
  name: string;
  price: number;
  stock: number;
  emoji: string;
  version?: number;
  description?: string;
  variant?: string;
  category?: string;
  image?: string;
  published?: number;
  featured?: number;
}
export interface Order {
  currency?: Currency;
  country_code?: CountryCode;
  id: number;
  reference: string;
  customer: string;
  email: string;
  phone: string;
  address: string;
  total: number;
  status: "pending" | "paid" | "cancelled" | "refunded";
  payment_status?: string;
  agent_name?: string;
  commission: number;
  created: string;
  note?: string;
  shipping?: number;
  discount?: number;
  subtotal?: number;
  state?: string;
  postcode?: string;
  city?: string;
  fulfillment_status?: "unfulfilled" | "shipped";
  carrier?: string;
  tracking?: string;
  shipped_at?: string;
}
export interface Agent {
  id: number;
  name: string;
  code: string;
  rate: number;
  earned: number;
  orders_count: number;
}
export interface Dashboard {
  merchant: Merchant;
  products: Product[];
  orders: Order[];
  agents: Agent[];
}
export interface Item {
  content_translations?: ContentTranslations;
  name: string;
  price: number;
  quantity: number;
}
export interface OrderResult {
  payment_instructions?: import("./merchant-receiving").ReceivingInstructions;
  order: Order;
  items: Item[];
  store?: Merchant;
}
export interface CartLine {
  id: number;
  quantity: number;
}
