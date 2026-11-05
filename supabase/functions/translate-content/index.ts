// Retired endpoint: deployment replaces any older implementation so it can no
// longer contact a translation provider, even if old credentials still exist.
import { appUrl } from "../_shared/payment-security.ts";
Deno.serve((req: Request) => {
  let root: URL;
  try { root = appUrl(Deno.env.get("APP_URL")); }
  catch { return new Response("Service not configured", { status: 503 }); }
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": root.origin,
    "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-client-info",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
  if (req.headers.get("Origin") && req.headers.get("Origin") !== root.origin)
    return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({ error: "Automatic translation has been removed. Enter content manually." }), { status: 410, headers });
});
