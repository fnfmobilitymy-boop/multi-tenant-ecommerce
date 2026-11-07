import { pathToFileURL } from "node:url";

export function domainAuthSettings(current, domain) {
  if (domain !== "ezshop.lifestyle") throw new Error("Unexpected domain");
  const site = `https://${domain}/merchant`;
  const required = [
    site,
    `https://${domain}/reset-password`,
    `https://${domain}/shop/**`,
  ];
  const existing = String(current.uri_allow_list || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // Keep the old default callback usable after changing the default website.
  if (typeof current.site_url === "string" && current.site_url)
    existing.push(current.site_url);
  return {
    site_url: site,
    uri_allow_list: [...new Set([...existing, ...required])].join(","),
  };
}

export async function configureDomainAuth(env, fetcher = fetch) {
  const domain = (env.EZSHOP_CUSTOM_DOMAIN || "").trim().toLowerCase();
  if (!domain) return { enabled: false, changed: false };
  if (domain !== "ezshop.lifestyle") throw new Error("Unexpected domain");
  const hostRef = new URL(env.VITE_SUPABASE_URL).hostname.match(
    /^([a-z]{20})\.supabase\.co$/,
  )?.[1];
  const ref = env.SUPABASE_PROJECT_REF || hostRef;
  if (
    !ref ||
    !/^[a-z]{20}$/.test(ref) ||
    ref !== hostRef ||
    !env.SUPABASE_ACCESS_TOKEN
  )
    throw new Error("Missing or inconsistent project configuration");
  const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const request = async (method, body) => {
    const response = await fetcher(url, {
      method,
      headers: {
        Authorization: "Bearer " + env.SUPABASE_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    // Never include the response body: auth configuration can contain secrets.
    if (!response.ok)
      throw Object.assign(new Error(`Auth configuration HTTP ${response.status}`), { status: response.status });
    return response;
  };
  const current = await (await request("GET")).json();
  const desired = domainAuthSettings(current, domain);
  const changed =
    current.site_url !== desired.site_url ||
    current.uri_allow_list !== desired.uri_allow_list;
  if (changed) await request("PATCH", desired);
  const actual = await (await request("GET")).json();
  const actualUrls = new Set(
    String(actual.uri_allow_list || "")
      .split(",")
      .map((value) => value.trim()),
  );
  if (
    actual.site_url !== desired.site_url ||
    desired.uri_allow_list.split(",").some((value) => !actualUrls.has(value))
  )
    throw new Error("Auth configuration verification failed");
  return { enabled: true, changed };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await configureDomainAuth(process.env);
    console.log(
      result.enabled
        ? "新域名登录回跳已回读验证；原回跳地址保留，未修改其他认证配置，也未发送邮件。"
        : "未启用新域名，不修改登录配置。",
    );
  } catch (error) {
    if (Number.isInteger(error?.status)) console.error(`::error::Domain auth configuration HTTP ${error.status}`);
    console.error(
      "新域名登录回跳未验证完成。请检查管理令牌权限或在 Supabase URL Configuration 手动设置；不输出认证配置或密钥。",
    );
    process.exitCode = 1;
  }
}
