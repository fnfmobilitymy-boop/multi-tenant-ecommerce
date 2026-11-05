export function publicConfig(env) {
  const value = env.VITE_SUPABASE_URL,
    key = env.VITE_SUPABASE_ANON_KEY;
  if (!value || !key) throw new Error("缺少公开 Supabase URL 或 anon key");
  const root = new URL(value);
  root.pathname = root.pathname
    .replace(/\/rest\/v1\/?$/, "")
    .replace(/\/+$/, "");
  if (
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    (root.protocol !== "https:" &&
      !(
        root.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(root.hostname)
      ))
  )
    throw new Error("Supabase URL 格式无效");
  if (key.startsWith("sb_secret_"))
    throw new Error("不能把服务端密钥用于前端或公开检查");
  if (!key.startsWith("sb_publishable_")) {
    let claims;
    try {
      claims = JSON.parse(
        Buffer.from(key.split(".")[1], "base64url").toString(),
      );
    } catch {
      throw new Error("请配置有效的 anon / publishable key");
    }
    if (claims.role !== "anon")
      throw new Error("不能把服务端密钥用于前端或公开检查");
  }
  return {
    root: root.toString().replace(/\/$/, ""),
    headers: {
      apikey: key,
      ...(key.startsWith("sb_publishable_")
        ? {}
        : { Authorization: "Bearer " + key }),
      "Content-Type": "application/json",
    },
  };
}
export async function liveChecks(env, fetcher = fetch) {
  const { root, headers } = publicConfig(env);
  const checks = [];
  let manifest = null;
  async function probe(id, path, method, body) {
    try {
      const response = await fetcher(root + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      let result = null;
      if (response.ok && method !== "OPTIONS")
        try {
          result = await response.json();
        } catch {}
      return { http: response.status, result };
    } catch {
      return { http: 0, result: null };
    }
  }
  const health = await probe("health", "/rest/v1/rpc/ezshop_api", "POST", {
    route: "health",
    payload: {},
  });
  checks.push({
    id: "database_health",
    ok: health.result?.ok === true,
    http: health.http,
  });
  const database = await probe(
    "manifest",
    "/rest/v1/rpc/ezshop_release_status",
    "POST",
    {},
  );
  manifest = database.result;
  checks.push({
    id: "database_migrations",
    ok: manifest?.database_ready === true && manifest?.features?.trial_access === true && manifest?.features?.merchant_receiving === true,
    http: database.http,
  });
  const functions = await Promise.all(
    [
      "payments",
      "stripe-webhook",
      "send-notifications",
    ].map(async (name) => {
      const response = await probe(name, "/functions/v1/" + name, "OPTIONS");
      return {
        id: name,
        ok: [200, 204, 405].includes(response.http),
        http: response.http,
      };
    }),
  );
  checks.push(...functions);
  return {
    checks,
    database_ok: checks.slice(0, 2).every((check) => check.ok),
    functions_deployed: functions.every((check) => check.ok),
    features: manifest?.features || {},
    production_verified: false,
  };
}
export function reportText(report) {
  return [
    "EZShop 只读上线检查",
    ...report.checks.map(
      (check) =>
        (check.ok ? "通过" : "未通过") +
        " · " +
        check.id +
        " · HTTP " +
        check.http,
    ),
    "注意：函数可达不代表密钥有效、真实付款/投递已通过，或生产备份已完成。",
  ].join("\n");
}
