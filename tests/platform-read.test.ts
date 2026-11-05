import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
const db = new PGlite();
const admin = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222",
  buyer = "33333333-3333-4333-8333-333333333333";
let mid: number, other: number, oid: number;
async function user(id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function call(route: string, payload: Record<string, unknown> = {}) {
  return (
    await db.query<{ body: any }>(
      "select public.ezshop_platform_read_api($1,$2::jsonb) body",
      [route, JSON.stringify({ merchant_id: mid, ...payload })],
    )
  ).rows[0].body;
}
beforeAll(async () => {
  await db.exec(
    `create role anon;create role authenticated;create role service_role;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;create function storage.foldername(name text) returns text[] language sql immutable as $$select string_to_array(regexp_replace(name,'/[^/]*$',''),'/')$$;grant usage on schema auth,storage to anon,authenticated;grant select,insert,update,delete on storage.objects to authenticated;`,
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  for (const [id, email] of [
    [admin, "admin@example.test"],
    [owner, "owner@example.test"],
    [buyer, "buyer@example.test"],
  ])
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      email,
    ]);
  await db.query(
    "insert into ezshop.merchants(owner,name,slug,email,is_admin,trial_ends_at) values($1,'Admin','admin-store','admin@example.test',true,now()+interval '7 days'),($2,'Target','target-store','owner@example.test',false,now()+interval '7 days')",
    [admin, owner],
  );
  mid = Number(
    (
      await db.query<{ id: number }>(
        "select id from ezshop.merchants where owner=$1",
        [owner],
      )
    ).rows[0].id,
  );
  other = Number(
    (
      await db.query<{ id: number }>(
        "select id from ezshop.merchants where owner=$1",
        [admin],
      )
    ).rows[0].id,
  );
  await db.query(
    "insert into ezshop.products(merchant_id,name,price,stock,unit_cost) select $1,'Product '||n,1000,5,400 from generate_series(1,55) n",
    [mid],
  );
  const pid = (
    await db.query<{ id: number }>(
      "select min(id) id from ezshop.products where merchant_id=$1",
      [mid],
    )
  ).rows[0].id;
  oid = Number(
    (
      await db.query<{ id: number }>(
        "insert into ezshop.orders(merchant_id,reference,customer,email,phone,address,total,access_token,checkout_key) values($1,'EZ-PLATFORM','Buyer','buyer@example.test','0123456789','KL',2000,'never-expose-access','never-expose-checkout') returning id",
        [mid],
      )
    ).rows[0].id,
  );
  await db.query(
    "insert into ezshop.order_items(order_id,product_id,name,price,quantity,unit_cost) values($1,$2,'Product 1',1000,2,400)",
    [oid, pid],
  );
  await db.query("update ezshop.orders set status='paid' where id=$1", [oid]);
  await db.query(
    "insert into ezshop.finance_entries(merchant_id,kind,category,amount,occurred_on,description,request_key) values($1,'expense','advertising',200,current_date,'Campaign','never-expose-entry-key')",
    [mid],
  );
  await db.query(
    "insert into ezshop.memberships(merchant_id,name,email,role,invite_token,expires) values($1,'Staff','staff@example.test','manager','never-expose-invite',9999999999)",
    [mid],
  );
  await db.query(
    "insert into ezshop.orders(merchant_id,reference,customer,email,phone,address,total,access_token) values($1,'OTHER-ORDER','Other','other@example.test','0123456789','Other address',500,'other-secret')",
    [other],
  );
  await user(admin);
}, 30000);
afterAll(() => db.close());
it("匿名、普通商家和顾客不能读取平台明细，内部助手不允许直接调用", async () => {
  for (const id of ["", owner, buyer]) {
    await user(id);
    for (const route of [
      "overview",
      "products",
      "orders",
      "customers",
      "agents",
      "team",
      "payouts",
      "journal",
      "audit",
      "notifications",
      "order",
    ])
      await expect(call(route, { order_id: oid })).rejects.toThrow(
        "需要平台管理员权限",
      );
  }
  await db.exec("set role anon");
  await expect(call("overview")).rejects.toThrow();
  await db.exec("reset role");
  await user(admin);
  await db.exec("set role authenticated");
  await expect(
    db.query("select ezshop.platform_book_summary($1)", [mid]),
  ).rejects.toThrow();
  await expect(db.query("select * from ezshop.orders")).rejects.toThrow();
  expect((await call("overview")).merchant.id).toBe(mid);
  await db.exec("reset role");
});
it("管理员读取全部分页，包括未上架商品；不泄露凭证或其他店铺订单", async () => {
  await user(admin);
  const first = await call("products");
  const second = await call("products", { page: 2 });
  expect(first.total).toBe(55);
  expect(first.rows).toHaveLength(50);
  expect(second.rows).toHaveLength(5);
  expect(new Set([...first.rows, ...second.rows].map((x) => x.id)).size).toBe(
    55,
  );
  const orders = await call("orders");
  expect(orders.rows).toHaveLength(1);
  expect(orders.rows[0].email).toBe("buyer@example.test");
  expect(orders.rows[0].access_token).toBeUndefined();
  expect(JSON.stringify(orders)).not.toMatch(
    /never-expose|OTHER-ORDER|other-secret/,
  );
  const detail = await call("order", { order_id: oid });
  expect(detail.items[0].unit_cost).toBe(400);
  expect(detail.order.address).toBe("KL");
  expect(JSON.stringify(detail)).not.toMatch(/never-expose/);
  const otherOid = (
    await db.query<{ id: number }>(
      "select id from ezshop.orders where reference='OTHER-ORDER'",
    )
  ).rows[0].id;
  await expect(call("order", { order_id: otherOid })).rejects.toThrow(
    "找不到订单",
  );
  const team = await call("team");
  expect(team.rows[0].email).toBe("staff@example.test");
  expect(JSON.stringify(team)).not.toContain("never-expose-invite");
  const customers = await call("customers");
  expect(customers.rows[0].orders_count).toBe(1);
  expect(customers.rows[0].paid_total).toBe(2000);
  for (const route of [
    "agents",
    "payouts",
    "journal",
    "audit",
    "notifications",
  ])
    expect(await call(route)).toHaveProperty("rows");
});
it("平台利润与商家账本一致；暂停或到期商家仍可审查，管理员被暂停后立即拒绝", async () => {
  await user(owner);
  const books = (
    await db.query<{ body: any }>(
      "select public.ezshop_books_api('summary','{}') body",
    )
  ).rows[0].body;
  await user(admin);
  const overview = await call("overview");
  expect(overview.summary).toEqual(books.summary);
  expect(overview.summary.profit).toBe(1000);
  expect(overview.counts.stock).toBe(275);
  await db.query(
    "update ezshop.merchants set status='suspended',trial_ends_at=now()-interval '1 day' where id=$1",
    [mid],
  );
  expect((await call("overview")).merchant.status).toBe("suspended");
  await db.query("update ezshop.merchants set status='suspended' where id=$1", [
    other,
  ]);
  await expect(call("overview")).rejects.toThrow("需要平台管理员权限");
  await db.query("update ezshop.merchants set status='active' where id=$1", [
    other,
  ]);
});
it("拒绝写入路由、无效页码和商家编号；升级标记无业务数据", async () => {
  await user(admin);
  await expect(call("orders/paid", { order_id: oid })).rejects.toThrow(
    "仅支持读取",
  );
  await expect(call("products", { page: 0 })).rejects.toThrow();
  await expect(
    call("overview", { merchant_id: "1;drop table" }),
  ).rejects.toThrow();
  const before = (
    await db.query<{ status: string }>(
      "select status from ezshop.orders where id=$1",
      [oid],
    )
  ).rows[0].status;
  expect(before).toBe("paid");
  await db.exec("set role anon");
  expect(
    (
      await db.query<{ body: any }>(
        "select public.ezshop_platform_read_status() body",
      )
    ).rows[0].body,
  ).toEqual({ ready: true });
  await db.exec("reset role");
});
