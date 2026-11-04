import { createClient } from "@supabase/supabase-js";
import { supabaseApi } from "./supabase-api";
// Only public project credentials belong in the browser.
// Cloud adapter is enabled only when both project settings are supplied.
export const supabase =
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
      )
    : null;
export async function api<T>(path: string, data?: unknown): Promise<T> {
  if (supabase) return supabaseApi<T>(supabase, path, data);
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
export const money = (n: number) =>
  new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(
    n / 100,
  );
export const statusLabel = (s: string) =>
  ({
    pending: "待付款",
    paid: "已付款",
    cancelled: "已取消",
    refunded: "已退款",
  })[s] || s;
export const dateLabel = (s: string) =>
  new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").toLocaleString(
    "zh-CN",
    { timeZone: "Asia/Kuala_Lumpur", hour12: false },
  );
