export function summarizeBackups(body) {
  if (!body || !Array.isArray(body.backups))
    return {
      state: "unknown",
      database_backup_count: null,
      latest_backup_at: null,
      completed_backup_count: null,
      unknown_status_count: null,
      pitr_enabled: null,
      storage_backup_verified: false,
      restore_verified: false,
    };
  const dates = body.backups
    .map((item) => item?.inserted_at || item?.created_at)
    .filter(
      (value) =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  const completed = body.backups.filter(
    (item) => item?.status === "COMPLETED",
  ).length;
  const unknown = body.backups.filter(
    (item) => typeof item?.status !== "string",
  ).length;
  return {
    completed_backup_count: completed,
    unknown_status_count: unknown,
    state: body.backups.length ? "listed" : "none_listed",
    database_backup_count: body.backups.length,
    latest_backup_at: dates[0] || null,
    pitr_enabled:
      typeof body.pitr_enabled === "boolean" ? body.pitr_enabled : null,
    storage_backup_verified: false,
    restore_verified: false,
  };
}
export async function checkBackups(env, fetcher = fetch) {
  const ref =
    env.SUPABASE_PROJECT_REF ||
    new URL(env.VITE_SUPABASE_URL).hostname.match(
      /^([a-z]{20})\.supabase\.co$/,
    )?.[1];
  if (!ref || !/^[a-z]{20}$/.test(ref) || !env.SUPABASE_ACCESS_TOKEN)
    throw new Error("缺少项目编号或管理令牌");
  if (new URL(env.VITE_SUPABASE_URL).hostname !== ref + ".supabase.co")
    throw new Error("目标项目不一致");
  const response = await fetcher(
    "https://api.supabase.com/v1/projects/" + ref + "/database/backups",
    {
      method: "GET",
      headers: { Authorization: "Bearer " + env.SUPABASE_ACCESS_TOKEN },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) return { http: response.status, ...summarizeBackups(null) };
  return { http: response.status, ...summarizeBackups(await response.json()) };
}
