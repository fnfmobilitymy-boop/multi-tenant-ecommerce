export interface Merchant {
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
}
export interface Product {
  id: number;
  merchant_id?: number;
  name: string;
  price: number;
  stock: number;
  emoji: string;
  version?: number;
  description?: string;
  category?: string;
  image?: string;
  published?: number;
  featured?: number;
}
export interface Order {
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
  name: string;
  price: number;
  quantity: number;
}
export interface OrderResult {
  order: Order;
  items: Item[];
  store?: Merchant;
}
export interface CartLine {
  id: number;
  quantity: number;
}
