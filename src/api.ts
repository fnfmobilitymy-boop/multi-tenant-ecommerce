import {
  currencyFactor,
  currencyTimeZone,
  validCurrency,
  type Currency,
} from "../supabase/functions/_shared/currencies";
import { intlLocale, type Locale } from "./i18n-core";
import { createClient } from "@supabase/supabase-js";
import { supabaseApi } from "./supabase-api";
import { paymentsApi } from "./payments-api";
import { normalizeSupabaseUrl } from "./supabase-config";
import { isPasswordRecovery } from "./auth-redirect";
export const initialPasswordRecovery =
  typeof window !== "undefined" && isPasswordRecovery(window.location.href);
const portalPath =
  typeof window === "undefined"
    ? ""
    : window.location.pathname.slice(
        import.meta.env.BASE_URL.replace(/\/$/, "").length,
      );
const platformPortal = /^\/platform(?:\/|$)/.test(portalPath);
const customerPortal = /^\/shop\/[^/]+(?:\/|$)/.test(portalPath) || ((portalPath === "/" || portalPath === "") && !initialPasswordRecovery);
// Only public project credentials belong in the browser.
// Cloud adapter is enabled only when both project settings are supplied.
export const supabase =
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? createClient(
        normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
        import.meta.env.VITE_SUPABASE_ANON_KEY,
        {
          auth: {
            ...(platformPortal
              ? {
                  storageKey:
                    "ezshop-platform-auth-" +
                    new URL(
                      normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
                    ).hostname,
                }
              : {}),
            ...(customerPortal
              ? {
                  storageKey:
                    "ezshop-public-auth-" +
                    new URL(
                      normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
                    ).hostname,
                  persistSession: false,
                  autoRefreshToken: false,
                }
              : {}),
            detectSessionInUrl: !platformPortal && !customerPortal,
          },
        },
      )
    : null;
export async function api<T>(path: string, data?: unknown): Promise<T> {
  if (supabase && path.startsWith("platform-read/")) {
    const { data: result, error } = await supabase.rpc(
      "ezshop_platform_read_api",
      {
        route: path.slice(14),
        payload: data || {},
      },
    );
    if (error) throw new Error(error.message);
    return result as T;
  }
  if (supabase && path.startsWith("books/")) {
    const { data: result, error } = await supabase.rpc("ezshop_books_api", {
      route: path.slice(6),
      payload: data || {},
    });
    if (error) throw new Error(error.message);
    return result as T;
  }
  if (supabase && path.startsWith("platform-billing/")) {
    const { data: result, error } = await supabase.rpc(
      "ezshop_platform_billing_api",
      { route: path.slice(17), payload: data || {} },
    );
    if (error) throw new Error(error.message);
    return result as T;
  }
  if (supabase)
    return path.startsWith("payments/")
      ? paymentsApi<T>(supabase, path.slice(9), data)
      : supabaseApi<T>(supabase, path, data);
  const response = await fetch("/api/" + path, {
    credentials: "same-origin",
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败，请稍后重试");
  return body;
}
export const money = (
  n: number,
  locale: Locale = "en",
  currency: Currency = "MYR",
) => {
  if (!validCurrency(currency)) throw new Error("不支持的交易币种");
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency,
  }).format(n / currencyFactor(currency));
};
export const statusLabel = (s: string) =>
  ({
    pending: "待付款",
    paid: "已付款",
    cancelled: "已取消",
    refunded: "已退款",
  })[s] || s;
export const dateLabel = (
  s: string,
  locale: Locale = "zh",
  currency: Currency = "MYR",
) =>
  new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").toLocaleString(
    intlLocale(locale),
    { timeZone: currencyTimeZone(currency), hour12: false },
  );
