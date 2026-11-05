import { createClient } from "@supabase/supabase-js";
import { api } from "./api";
import { normalizeSupabaseUrl } from "./supabase-config";
import { supabaseApi } from "./supabase-api";
import { paymentsApi } from "./payments-api";
const customerPath =
  typeof window !== "undefined" &&
  /\/shop\/[^/]+(?:\/|$)/.test(window.location.pathname);
export const customerRecovery =
  customerPath &&
  new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery";
// Customer login must not replace the merchant/platform browser session.
export const customerClient =
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? createClient(
        normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
        import.meta.env.VITE_SUPABASE_ANON_KEY,
        {
          auth: {
            storageKey:
              "ezshop-customer-auth-" +
              new URL(normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL))
                .hostname,
            detectSessionInUrl: customerPath,
          },
        },
      )
    : null;
export async function storeApi<T>(path: string, data?: unknown): Promise<T> {
  if (!customerClient) return api<T>(path, data);
  return path.startsWith("payments/")
    ? paymentsApi<T>(customerClient, path.slice(9), data)
    : supabaseApi<T>(customerClient, path, data);
}
export async function customerApi<T>(
  route: string,
  payload: unknown = {},
): Promise<T> {
  if (!customerClient)
    throw new Error("顾客账号暂不可用，请使用订单查询凭证。");
  const { data, error } = await customerClient.rpc("ezshop_customer_api", {
    route,
    payload,
  });
  if (error) throw new Error(error.message);
  return data as T;
}
if (customerClient && typeof window !== "undefined")
  customerClient.auth.onAuthStateChange((event) => {
    if (event !== "SIGNED_OUT") return;
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("ezshop:order:")) sessionStorage.removeItem(key);
    window.dispatchEvent(new Event("ezshop:customer-signout"));
  });
