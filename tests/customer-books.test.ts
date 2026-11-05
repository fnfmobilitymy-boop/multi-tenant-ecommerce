import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111",
  buyer = "22222222-2222-4222-8222-222222222222",
  other = "33333333-3333-4333-8333-333333333333",
  unverified = "44444444-4444-4444-8444-444444444444";
let mid: number, pid: number, reference: string, token: string, oid: number;
async function user(id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function call(fn: string, route: string, payload: unknown = {}) {
  return (
    await db.query<{ body: any }>(`select public.${fn}($1,$2::jsonb) body`, [
      route,
      JSON.stringify(payload),
    ])
  ).rows[0].body;
}
const main = (route: string, payload: unknown = {}) =>
    call("ezshop_api", route, payload),
  books = (route: string, payload: unknown = {}) =>
    call("ezshop_books_api", route, payload),
  customer = (route: string, payload: unknown = {}) =>
    call("ezshop_customer_api", route, payload);
async function place(key: string, email = "buyer@example.test", quantity = 1) {
  return main("checkout", {
    slug: "books-store",
    customer: "Buyer",
    email,
    phone: "0123456789",
    address: "KL",
    items: [{ id: pid, quantity }],
    checkout_key: "customer_books_checkout_" + key,
  });
}
beforeAll(async () => {
  await db.exec(
    `create role anon;create role authenticated;create role service_role;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;create function storage.foldername(name text) returns text[] language sql immutable as $$select string_to_array(regexp_replace(name,'/[^/]*$',''),'/')$$;grant usage on schema auth,storage to anon,authenticated;grant select,insert,update,delete on storage.objects to authenticated;`,
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  for (const [id, email, meta, verified] of [
    [
      owner,
      "owner@example.test",
      { name: "Books Store", slug: "books-store" },
      true,
    ],
    [buyer, "buyer@example.test", {}, true],
    [
      other,
      "other@example.test",
      { name: "Other Store", slug: "books-other" },
      true,
    ],
    [unverified, "unverified@example.test", {}, false],
  ] as const)
    await db.query("insert into auth.users values($1,$2,$3,$4)", [
      id,
      email,
      JSON.stringify(meta),
      verified ? new Date().toISOString() : null,
    ]);
  await user(owner);
  mid = (await main("dashboard")).merchant.id;
  await main("products", {
    name: "Costed Item",
    price: 1000,
    unit_cost: 400,
    stock: 50,
    published: 1,
  });
  pid = (await main("dashboard")).products[0].id;
}, 30000);
afterAll(() => db.close());
it("登录下单自动归属本人，消费件数只统计已付订单，其他人及未验证邮箱不能读取", async () => {
  await user(buyer);
  const order = await place("signed", undefined, 2);
  reference = order.reference;
  token = order.access_token;
  let history = await customer("history", { slug: "books-store" });
  expect(history.summary.paid_total).toBe(0);
  expect(history.summary.pending_count).toBe(1);
  expect(history.summary.purchased_quantity).toBe(0);
  await user(owner);
  oid = (await main("dashboard")).orders[0].id;
  await main("orders/paid", { id: oid });
  await main("orders/paid", { id: oid });
  await user(buyer);
  history = await customer("history", { slug: "books-store" });
  expect(history.summary.paid_total).toBe(2000);
  expect(history.summary.purchased_quantity).toBe(2);
  expect(history.orders[0].access_token).toBe(token);
  expect(JSON.stringify(history)).not.toContain("unit_cost");
  await user(other);
  expect(
    (await customer("history", { email: "buyer@example.test" })).orders,
  ).toEqual([]);
  await user(unverified);
  await expect(customer("history")).rejects.toThrow("验证");
  await user("");
  await db.exec("set role anon");
  await expect(customer("history")).rejects.toThrow();
  await db.exec("reset role");
});
it("访客订单须凭证加已验证邮箱才能关联，不能通过重试结账偷换归属", async () => {
  await user("");
  const order = await place("guest");
  await user(other);
  await expect(
    customer("claim", {
      slug: "books-store",
      reference: order.reference,
      token: order.access_token,
    }),
  ).rejects.toThrow("无法关联");
  await place("guest");
  expect((await customer("history")).orders).toEqual([]);
  await user(buyer);
  await expect(
    customer("claim", {
      slug: "books-store",
      reference: order.reference,
      token: "wrong",
    }),
  ).rejects.toThrow();
  await customer("claim", {
    slug: "books-store",
    reference: order.reference,
    token: order.access_token,
  });
  await customer("claim", {
    slug: "books-store",
    reference: order.reference,
    token: order.access_token,
  });
  expect((await customer("history")).orders).toHaveLength(2);
  await user(other);
  await expect(
    customer("claim", {
      slug: "books-store",
      reference: order.reference,
      token: order.access_token,
    }),
  ).rejects.toThrow();
});
it("利润按成本快照自动计算，重复确认不重记；支出幂等、作废留痕，进货和投入不重复影响利润", async () => {
  await user(owner);
  let report = await books("summary");
  expect(report.summary.receipts).toBe(2000);
  expect(report.summary.goods_cost).toBe(800);
  expect(report.summary.profit).toBe(1200);
  expect(report.rows.filter((r: any) => r.kind === "payment")).toHaveLength(1);
  const product = (await main("dashboard")).products[0];
  await main("products/update", { ...product, unit_cost: 900 });
  expect((await books("summary")).summary.goods_cost).toBe(800);
  const day = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date());
  const entry = {
    kind: "expense",
    category: "advertising",
    amount: 200,
    occurred_on: day,
    description: "Test ad cost",
    request_key: "books_entry_advertising_0001",
  };
  await books("entry/add", entry);
  await books("entry/add", entry);
  await expect(books("entry/add", { ...entry, amount: 999 })).rejects.toThrow(
    "不一致",
  );
  await books("entry/add", {
    ...entry,
    category: "shipping",
    amount: 50,
    request_key: "books_entry_shipping_0000001",
  });
  await books("entry/add", {
    ...entry,
    category: "inventory",
    amount: 500,
    request_key: "books_entry_inventory_000001",
  });
  await books("entry/add", {
    ...entry,
    kind: "income",
    category: "capital",
    amount: 1000,
    request_key: "books_entry_capital_00000001",
  });
  report = await books("summary");
  expect(report.summary.profit).toBe(950);
  expect(report.summary.net_cash).toBe(2250);
  const ad = report.rows.find(
    (r: any) => r.source === "manual" && r.category === "advertising",
  );
  await books("entry/void", {
    id: ad.id,
    reason: "Duplicate receipt correction",
  });
  report = await books("summary");
  expect(report.summary.profit).toBe(1150);
  expect(
    report.rows.find((r: any) => r.source === "manual" && r.id === ad.id)
      .voided,
  ).toBe(true);
  await user(buyer);
  await expect(books("summary")).rejects.toThrow("所有者");
  await user(other);
  await main("dashboard");
  await expect(
    books("entry/void", { id: ad.id, reason: "Cross tenant" }),
  ).rejects.toThrow();
});
it("缺成本不伪造利润，可更正补录；退款自动反映消费与账本，日期按马来西亚边界筛选", async () => {
  await user(owner);
  await main("products", {
    name: "Unknown Cost",
    price: 500,
    stock: 2,
    published: 1,
  });
  const unknown = (await main("dashboard")).products[0];
  await user("");
  const placed = await main("checkout", {
    slug: "books-store",
    customer: "Buyer",
    email: "buyer@example.test",
    phone: "0123456789",
    address: "KL",
    items: [{ id: unknown.id, quantity: 1 }],
    checkout_key: "unknown_cost_checkout_00001",
  });
  await user(owner);
  const order = (await main("dashboard")).orders.find(
    (o: any) => o.reference === placed.reference,
  );
  await main("orders/paid", { id: order.id });
  expect((await books("summary")).summary.profit).toBeNull();
  const details = await books("order", { id: order.id });
  await books("order-costs", {
    id: order.id,
    version: details.version,
    reason: "Actual supplier receipt",
    items: details.items.map((i: any) => ({ id: i.id, unit_cost: 200 })),
  });
  expect((await books("summary")).summary.profit).toBe(1450);
  await main("orders/refund", {
    id: oid,
    reference: "test_actual_refund_reference",
    restock: true,
  });
  let report = await books("summary");
  expect(report.summary.refunds).toBe(2000);
  expect(report.summary.goods_cost).toBe(200);
  expect(report.summary.profit).toBe(250);
  await user(buyer);
  const history = await customer("history");
  expect(history.summary.paid_total).toBe(0);
  expect(history.summary.refunded_total).toBe(2000);
  expect(history.summary.purchased_quantity).toBe(0);
  await user(owner);
  await db.query(
    "update ezshop.finance_events set occurred_at='2026-11-04T16:00:00Z' where order_id=$1 and kind='payment'",
    [order.id],
  );
  expect(
    (await books("summary", { date: "2026-11-05" })).rows.some(
      (r: any) => r.order_id === order.id && r.kind === "payment",
    ),
  ).toBe(true);
  expect(
    (await books("summary", { date: "2026-11-04" })).rows.some(
      (r: any) => r.order_id === order.id && r.kind === "payment",
    ),
  ).toBe(false);
});

it("成本与账本不向顾客或其他商家泄露，试用到期不能修改账本但顾客仍可查旧单", async () => {
  await user("");
  const store = await main("store", { slug: "books-store" });
  expect(store.products.every((p: any) => !("unit_cost" in p))).toBe(true);
  const result = await main("order-result", {
    slug: "books-store",
    reference,
    token,
  });
  expect(JSON.stringify(result)).not.toContain("unit_cost");
  await user(other);
  await expect(books("order", { id: oid })).rejects.toThrow("找不到");
  await user(owner);
  await db.query(
    "update ezshop.merchants set trial_ends_at=now()-interval '1 minute' where id=$1",
    [mid],
  );
  await expect(books("summary")).rejects.toThrow("到期");
  await user(buyer);
  expect((await customer("history")).orders.length).toBeGreaterThan(0);
  await db.exec("set role authenticated");
  await expect(
    db.exec("select * from ezshop.finance_events"),
  ).rejects.toThrow();
  await expect(call("ezshop_customer_store_api", "health")).rejects.toThrow();
  await db.exec("reset role");
  await db.query(
    "update ezshop.merchants set trial_ends_at=now()+interval '1 day' where id=$1",
    [mid],
  );
});
it("历史收款日期未知时不伪造时间，补录成本和核实日期后按期统计", async () => {
  await user(other);
  const merchant = (await main("dashboard")).merchant.id;
  const product = (
    await db.query<{ id: number }>(
      "insert into ezshop.products(merchant_id,name,price,stock) values($1,$2,100,0) returning id",
      [merchant, "Legacy item"],
    )
  ).rows[0].id;
  const order = (
    await db.query<{ id: number }>(
      "insert into ezshop.orders(merchant_id,reference,customer,email,phone,address,total,status,access_token) values($1,'LEGACY-BOOK-TEST','Buyer','old@example.test','0123456789','KL',100,'paid','legacy-private-code') returning id",
      [merchant],
    )
  ).rows[0].id;
  const item = (
    await db.query<{ id: number }>(
      "insert into ezshop.order_items(order_id,product_id,name,price,quantity) values($1,$2,$3,100,1) returning id",
      [order, product, "Legacy item"],
    )
  ).rows[0].id;
  await db.query(
    "insert into ezshop.finance_events(merchant_id,order_id,kind,amount,occurred_at) values($1,$2,'payment',100,null)",
    [merchant, order],
  );
  let result = await books("summary");
  expect(result.summary.unknown_date_events).toBe(1);
  expect(result.summary.profit).toBeNull();
  expect((await books("summary", { month: "2026-11" })).summary.receipts).toBe(
    0,
  );
  await books("order-costs", {
    id: order,
    version: 0,
    reason: "Verified historical receipt",
    paid_on: "2026-11-01",
    items: [{ id: item, unit_cost: 20 }],
  });
  result = await books("summary", { month: "2026-11" });
  expect(result.summary.receipts).toBe(100);
  expect(result.summary.profit).toBe(80);
  expect(result.summary.unknown_date_events).toBe(0);
});
