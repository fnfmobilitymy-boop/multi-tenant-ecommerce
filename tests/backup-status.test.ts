import { it, expect } from "vitest";
import {
  checkBackups,
  summarizeBackups,
} from "../scripts/backup-status-lib.mjs";
const env = {
  SUPABASE_PROJECT_REF: "a".repeat(20),
  VITE_SUPABASE_URL: "https://" + "a".repeat(20) + ".supabase.co",
  SUPABASE_ACCESS_TOKEN: "fixture-private-token",
};
it("仅GET目标项目；只汇总备份数和日期，不泄露文件地址或凭据，不冒充图片备份及恢复验证", async () => {
  const report = await checkBackups(env, async (url: any, options: any) => {
    expect(String(url)).toBe(
      "https://api.supabase.com/v1/projects/" +
        "a".repeat(20) +
        "/database/backups",
    );
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
    return new Response(
      JSON.stringify({
        pitr_enabled: true,
        backups: [
          {
            status: "COMPLETED",
            inserted_at: "2026-11-04T00:00:00Z",
            download_url: "private-download",
          },
          { inserted_at: "2026-11-05T00:00:00Z" },
        ],
      }),
    );
  });
  expect(report).toEqual({
    http: 200,
    state: "listed",
    database_backup_count: 2,
    completed_backup_count: 1,
    unknown_status_count: 1,
    latest_backup_at: "2026-11-05T00:00:00Z",
    pitr_enabled: true,
    storage_backup_verified: false,
    restore_verified: false,
  });
  expect(JSON.stringify(report)).not.toMatch(/private-download|private-token/);
});
it("权限不足及未知响应不冒充没有备份，空列表也不冒充恢复完成", async () => {
  expect(
    (await checkBackups(env, async () => new Response("{}", { status: 403 })))
      .state,
  ).toBe("unknown");
  expect(summarizeBackups({})).toHaveProperty("state", "unknown");
  expect(summarizeBackups({ backups: [] })).toHaveProperty(
    "state",
    "none_listed",
  );
});
it("项目不匹配时不发送令牌", async () => {
  await expect(
    checkBackups(
      { ...env, VITE_SUPABASE_URL: "https://other.supabase.co" },
      async () => {
        throw new Error("must not fetch");
      },
    ),
  ).rejects.toThrow("项目不一致");
});
