import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { publicConfig, liveChecks } from "../scripts/live-check-lib.mjs";
import { notificationMessage } from "../supabase/functions/_shared/mail-template";
const key = (role: string) =>
  "fixture." +
  Buffer.from(JSON.stringify({ role })).toString("base64url") +
  ".fixture";
it("只读检查拒绝服务端密钥并且不把可达状态冒充生产验收", async () => {
  expect(() =>
    publicConfig({
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_ANON_KEY: key("service_role"),
    }),
  ).toThrow();
  const calls: any[] = [];
  const report = await liveChecks(
    {
      VITE_SUPABASE_URL: "https://test.supabase.co/rest/v1",
      VITE_SUPABASE_ANON_KEY: key("anon"),
    },
    async (url: any, options: any) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify(
          url.endsWith("ezshop_api")
            ? { ok: true }
            : url.endsWith("ezshop_release_status")
              ? {
                  database_ready: true,
                  features: {
                    trial_access: true,
                    merchant_receiving: true,
                    customer_accounts: true,
                    bookkeeping: true,
                  },
                }
              : url.endsWith("ezshop_manual_billing_status")
                ? { ready: true, automatic_pro_enabled: false }
                : url.endsWith("ezshop_platform_read_status") ||
                    url.endsWith("ezshop_region_status")
                  ? { ready: true }
                  : {},
        ),
        { status: options.method === "OPTIONS" ? 405 : 200 },
      );
    },
  );
  expect(report.database_ok).toBe(true);
  expect(report.functions_deployed).toBe(true);
  expect(report.production_verified).toBe(false);
  expect(
    calls.every(
      (call) => call.options.method === "OPTIONS" || call.url.includes("/rpc/"),
    ),
  ).toBe(true);
});
it("通知六语、金额和 HTML 转义，不允许把提醒写成收款成功", () => {
  for (const locale of ["zh", "en", "ms", "th", "km", "vi"]) {
    const receipt = notificationMessage({
      kind: "receipt",
      locale,
      store_name: "<script>bad</script>",
      reference: "EZ-TEST",
      shipping: 500,
      total: 1500,
      items: [{ name: "<img src=x>", price: 1000, quantity: 1 }],
    });
    expect(receipt.html).not.toContain("<script>");
    expect(receipt.html).toContain("&lt;img");
    expect(receipt.text).toContain("MYR 15.00");
    const reminder = notificationMessage({
      kind: "reminder",
      locale,
      store_name: "Store",
      reference: "EZ-TEST",
      total: 1000,
      items: [{ name: "A", price: 1000, quantity: 1 }],
    });
    expect(reminder.subject).not.toBe(receipt.subject);
  }
});
it("从已存在004的项目升级可重复，不破坏旧数据或RPC链", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;create function storage.foldername(name text) returns text[] language sql immutable as $$select string_to_array(regexp_replace(name,'/[^/]*$',''),'/')$$;grant usage on schema auth,storage to anon,authenticated;grant select,insert,update,delete on storage.objects to authenticated;`,
    );
    for (const file of readdirSync("supabase/migrations")
      .filter((file) => /000[1-4]_/.test(file))
      .sort())
      await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
    await db.exec(
      "insert into auth.users values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','legacy@example.test','{}');insert into ezshop.merchants(owner,name,slug,email) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Legacy','legacy','legacy@example.test')",
    );
    const bundle = readFileSync("supabase/upgrade-after-004.sql", "utf8");
    await db.exec(bundle);
    await db.exec(bundle);
    expect(
      (await db.query<{ name: string }>("select name from ezshop.merchants"))
        .rows[0].name,
    ).toBe("Legacy");
    const status = (
      await db.query<{ body: any }>(
        "select public.ezshop_release_status() body",
      )
    ).rows[0].body;
    expect(status.database_ready).toBe(true);
    expect(
      (
        await db.query<{ body: any }>(
          "select public.ezshop_platform_read_status() body",
        )
      ).rows[0].body.ready,
    ).toBe(true);
    await db.exec("set role anon");
    await expect(
      db.exec("select public.ezshop_content_api('health','{}')"),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 30000);

it("发布验证保留仓库路径，拒绝旧版本和缺少新功能的构建", async () => {
  const { verifySiteRelease } = await import("../scripts/site-release-lib.mjs");
  const sha = "a".repeat(40);
  let requested = "";
  const fetcher = async (url: any, options: any) => {
    requested = String(url);
    expect(options.method).toBe("GET");
    expect(options.headers).toBeUndefined();
    return new Response(
      JSON.stringify({
        commit: sha,
        features: {
          bookkeeping: true,
          customer_accounts: true,
          merchant_receiving: true,
          platform_read: true,
          portal_navigation_isolated: true,
        },
      }),
    );
  };
  expect(
    await verifySiteRelease("https://example.test/ezshop", sha, fetcher),
  ).toBe(true);
  expect(requested).toContain("/ezshop/version.json?release=");
  expect(
    await verifySiteRelease(
      "https://example.test/ezshop",
      sha,
      async () =>
        new Response(
          JSON.stringify({
            commit: "b".repeat(40),
            features: { bookkeeping: true },
          }),
        ),
    ),
  ).toBe(false);
  expect(
    await verifySiteRelease(
      "https://example.test/ezshop",
      sha,
      async () =>
        new Response(
          JSON.stringify({ commit: sha, features: { bookkeeping: true } }),
        ),
    ),
  ).toBe(false);
  await expect(
    verifySiteRelease("https://user:private@example.test/", sha, fetcher),
  ).rejects.toThrow();
});
