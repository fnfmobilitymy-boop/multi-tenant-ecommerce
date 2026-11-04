import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
const db = new PGlite();
const idA = "11111111-1111-4111-8111-111111111111",
  idB = "22222222-2222-4222-8222-222222222222";
async function rpc(route: string, payload: unknown = {}) {
  const r = await db.query<{ body: any }>(
    "select public.ezshop_api($1,$2::jsonb) body",
    [route, JSON.stringify(payload)],
  );
  return r.rows[0].body;
}
async function user(id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
beforeAll(async () => {
  await db.exec(
    `create role anon; create role authenticated; create role service_role; create schema auth; create schema extensions; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`,
  );
  await db.exec(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(regexp_replace(name,'/[^/]*$',''),'/') $$;
    grant usage on schema storage,auth to authenticated,anon;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  }
  await db.query("insert into auth.users values($1,$2,$3),($4,$5,$6)", [
    idA,
    "a@example.test",
    JSON.stringify({ name: "Store A", slug: "store-a" }),
    idB,
    "b@example.test",
    JSON.stringify({ name: "Store B", slug: "store-b" }),
  ]);
}, 30000);
afterAll(() => db.close());
describe("Supabase PostgreSQL RPC", () => {
  it("认证商家使用现有 Auth 身份且数据隔离", async () => {
    await user(idA);
    let a = await rpc("dashboard");
    expect(a.merchant.slug).toBe("store-a");
    await rpc("products", {
      name: "Cookie",
      price: 1234,
      stock: 5,
      emoji: "🍪",
      published: 1,
    });
    await user(idB);
    const b = await rpc("dashboard");
    expect(b.products).toHaveLength(0);
    await expect(rpc("orders/detail", { id: 1 })).rejects.toThrow();
    await user("");
    await expect(rpc("dashboard")).rejects.toThrow("请先登录");
  });
  it("匿名顾客核价下单、幂等、访问凭证与商家归属校验", async () => {
    await user("");
    const store = await rpc("store", { slug: "store-a" });
    expect(store.products).toHaveLength(1);
    const pid = store.products[0].id;
    const payload = {
      slug: "store-a",
      customer: "Buyer",
      email: "buyer@example.test",
      phone: "0123456789",
      address: "KL",
      items: [{ id: pid, quantity: 2 }],
      checkout_key: "postgres-checkout-key-123456",
      total: 1,
    };
    const a = await rpc("checkout", payload);
    const b = await rpc("checkout", payload);
    expect(a.reference).toBe(b.reference);
    expect(a.total).toBe(2468);
    expect((await rpc("store", { slug: "store-a" })).products[0].stock).toBe(3);
    await expect(
      rpc("order-result", {
        slug: "store-a",
        reference: a.reference,
        token: "bad",
      }),
    ).rejects.toThrow();
    await expect(
      rpc("order-result", {
        slug: "store-b",
        reference: a.reference,
        token: a.access_token,
      }),
    ).rejects.toThrow();
    const r = await rpc("order-result", {
      slug: "store-a",
      reference: a.reference,
      token: a.access_token,
    });
    expect(r.order.status).toBe("pending");
    expect(r.order.email).toBeUndefined();
    await user(idA);
    const d = await rpc("dashboard");
    expect(d.orders[0].access_token).toBeUndefined();
    await rpc("orders/cancel", { id: d.orders[0].id });
    await rpc("orders/cancel", { id: d.orders[0].id });
    expect((await rpc("store", { slug: "store-a" })).products[0].stock).toBe(5);
    await expect(rpc("orders/paid", { id: d.orders[0].id })).rejects.toThrow();
  });
  it("匿名角色不能直接读取底层表", async () => {
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from ezshop.orders")).rejects.toThrow();
      await expect(
        db.query("select public.ezshop_core_api('dashboard','{}'::jsonb)"),
      ).rejects.toThrow();
      const r = await rpc("store", { slug: "store-a" });
      expect(r.store.email).toBeUndefined();
    } finally {
      await db.exec("reset role");
    }
  });
  it("团队邀请、最小权限、代理隐私和撤权在 PostgreSQL 侧执行", async () => {
    const inventory = "33333333-3333-4333-8333-333333333333",
      agent = "44444444-4444-4444-8444-444444444444";
    await db.query("insert into auth.users values($1,$2,$3),($4,$5,$6)", [
      inventory,
      "inventory@example.test",
      "{}",
      agent,
      "agent@example.test",
      "{}",
    ]);
    await user(idA);
    const inv = await rpc("team/invite", {
      name: "Inventory",
      email: "inventory@example.test",
      role: "inventory",
    });
    await user(inventory);
    await rpc("join", { token: inv.invite_token });
    let d = await rpc("dashboard");
    expect(d.merchant.role).toBe("inventory");
    expect(d.orders).toHaveLength(0);
    await expect(rpc("settings", { name: "Forbidden" })).rejects.toThrow();
    await expect(rpc("team")).rejects.toThrow();
    await expect(rpc("platform")).rejects.toThrow();
    await user(idA);
    const ai = await rpc("team/invite", {
      name: "Agent",
      email: "agent@example.test",
      role: "agent",
      rate: 10,
    });
    await user(agent);
    await rpc("join", { token: ai.invite_token });
    d = await rpc("dashboard");
    expect(d.merchant.role).toBe("agent");
    const code = d.agents[0].code;
    await user("");
    const p = (await rpc("store", { slug: "store-a" })).products[0];
    await rpc("checkout", {
      slug: "store-a",
      customer: "Private",
      email: "private@example.test",
      phone: "0123456789",
      address: "Private street",
      items: [{ id: p.id, quantity: 1 }],
      agent: code,
      checkout_key: "affiliate-key-1234567890",
    });
    await user(agent);
    d = await rpc("dashboard");
    expect(d.orders).toHaveLength(1);
    expect(d.orders[0].email).toBeUndefined();
    expect(d.orders[0].address).toBeUndefined();
    await expect(
      rpc("orders/detail", { id: d.orders[0].id }),
    ).rejects.toThrow();
    await user(idA);
    const team = await rpc("team");
    const member = team.members.find(
      (m: any) => m.email === "inventory@example.test",
    );
    await rpc("team/revoke", { id: member.id });
    await user(inventory);
    await expect(rpc("dashboard")).rejects.toThrow();
  });
  it("平台管理员只能通过可信数据库操作授权", async () => {
    await user(idB);
    await expect(rpc("platform")).rejects.toThrow();
    await db.query("update ezshop.merchants set is_admin=true where owner=$1", [
      idA,
    ]);
    await user(idA);
    const stores = await rpc("platform");
    const target = stores.merchants.find((m: any) => m.slug === "store-b");
    await rpc("platform/update", {
      id: target.id,
      plan: "pro",
      status: "suspended",
    });
    await user(idB);
    await expect(rpc("dashboard")).rejects.toThrow();
    await user("");
    await expect(rpc("store", { slug: "store-b" })).rejects.toThrow();
    await user(idA);
    await rpc("platform/update", {
      id: target.id,
      plan: "pro",
      status: "active",
    });
    await user(idB);
    expect((await rpc("dashboard")).merchant.plan).toBe("pro");
  });

  it("邮件队列只允许服务角色领取，重复确认付款不重复排队", async () => {
    await user(idA);
    const orders = (await rpc("dashboard")).orders;
    const pending = orders.find((o: any) => o.status === "pending");
    await rpc("orders/paid", { id: pending.id });
    await rpc("orders/paid", { id: pending.id });
    const before = await rpc("notifications");
    expect(before.jobs).toHaveLength(1);
    expect(before.jobs[0].status).toBe("queued");
    await expect(rpc("mail/claim")).rejects.toThrow();
    await db.query(
      "select set_config('request.jwt.claim.role','service_role',false)",
    );
    await user("");
    try {
      const job = await rpc("mail/claim");
      expect(job.reference).toBe(pending.reference);
      expect(job.status).toBe("sending");
      expect(await rpc("mail/claim")).toBeNull();
      await rpc("mail/finish", {
        id: job.id,
        status: "sent",
        provider_id: "test-provider-id",
      });
    } finally {
      await db.query("select set_config('request.jwt.claim.role','',false)");
      await user(idA);
    }
    expect((await rpc("notifications")).jobs[0].status).toBe("sent");
  });
  it("提现预留与退款回冲在 PostgreSQL 中保持账本一致", async () => {
    const owner = "66666666-6666-4666-8666-666666666666",
      agent = "77777777-7777-4777-8777-777777777777";
    await db.query("insert into auth.users values($1,$2,$3),($4,$5,$6)", [
      owner,
      "financeowner@example.test",
      JSON.stringify({ name: "Finance Store", slug: "finance-store" }),
      agent,
      "financeagent@example.test",
      "{}",
    ]);
    await user(owner);
    await rpc("dashboard");
    await rpc("products", {
      name: "Finance Product",
      price: 10000,
      stock: 10,
      published: 1,
    });
    const product = (await rpc("dashboard")).products[0];
    const invite = await rpc("team/invite", {
      name: "Finance Agent",
      email: "financeagent@example.test",
      role: "agent",
      rate: 50,
    });
    await user(agent);
    await rpc("join", { token: invite.invite_token });
    const code = (await rpc("dashboard")).agents[0].code;
    await user("");
    await rpc("checkout", {
      slug: "finance-store",
      customer: "Buyer",
      email: "financebuyer@example.test",
      phone: "0123456789",
      address: "KL",
      agent: code,
      items: [{ id: product.id, quantity: 1 }],
      checkout_key: "finance-order-key-123456",
    });
    await user(owner);
    const order = (await rpc("dashboard")).orders[0];
    await rpc("orders/paid", { id: order.id });
    await user(agent);
    const request = {
      amount: 3000,
      bank_details: "Test Bank / Test beneficiary",
      request_key: "finance-payout-key-12345",
    };
    const payout = await rpc("payouts/request", request);
    expect((await rpc("payouts/request", request)).id).toBe(payout.id);
    await expect(
      rpc("payouts/request", { ...request, amount: 3001 }),
    ).rejects.toThrow();
    await expect(
      rpc("payouts/request", {
        ...request,
        amount: 2500,
        request_key: "second-payout-key-123456",
      }),
    ).rejects.toThrow();
    const pending = await rpc("payouts/request", {
      ...request,
      amount: 2000,
      request_key: "pending-payout-key-123456",
    });
    expect((await rpc("payouts")).balances[0].available).toBe(0);
    await expect(
      rpc("payouts/update", {
        id: payout.id,
        status: "paid",
        reference: "TEST-TRANSFER",
      }),
    ).rejects.toThrow();
    await user(idB);
    await expect(
      rpc("payouts/update", {
        id: payout.id,
        status: "paid",
        reference: "TEST-TRANSFER",
      }),
    ).rejects.toThrow();
    await user(owner);
    await rpc("payouts/update", {
      id: payout.id,
      status: "paid",
      reference: "TEST-TRANSFER",
    });
    await rpc("payouts/update", {
      id: payout.id,
      status: "paid",
      reference: "TEST-TRANSFER",
    });
    expect(
      (await rpc("payouts")).payouts.find((p: any) => p.id === payout.id)
        .reference,
    ).toBe("TEST-TRANSFER");
    await rpc("orders/refund", {
      id: order.id,
      reference: "TEST-REFUND",
      restock: true,
    });
    await rpc("orders/refund", {
      id: order.id,
      reference: "TEST-REFUND",
      restock: true,
    });
    await expect(
      rpc("orders/refund", { id: order.id, reference: "OTHER", restock: true }),
    ).rejects.toThrow();
    const d = await rpc("dashboard");
    expect(d.products[0].stock).toBe(10);
    expect(d.orders[0].status).toBe("refunded");
    expect(d.orders[0].refund_reference).toBe("TEST-REFUND");
    await user(agent);
    const ledger = await rpc("payouts");
    expect(ledger.balances[0].available).toBe(-3000);
    expect(ledger.balances[0].reserved).toBe(0);
    expect(ledger.payouts.find((p: any) => p.id === pending.id).status).toBe(
      "rejected",
    );
    await expect(
      rpc("payouts/request", {
        ...request,
        amount: 1,
        request_key: "after-refund-key-1234567",
      }),
    ).rejects.toThrow();
    await user(idB);
    expect((await rpc("payouts")).payouts).toHaveLength(0);
  });
  it("图片存储仅允许有效商家/员工上传到自己的目录", async () => {
    await user(idA);
    await db.exec("set role authenticated");
    try {
      await db.query(
        "insert into storage.objects(bucket_id,name) values($1,$2)",
        ["ezshop-media", idA + "/logo.png"],
      );
      await expect(
        db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
          "ezshop-media",
          idB + "/foreign.png",
        ]),
      ).rejects.toThrow();
      await expect(
        db.query("delete from storage.objects returning id"),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await db.exec("reset role");
    }
    await user("44444444-4444-4444-8444-444444444444");
    await db.exec("set role authenticated");
    try {
      await expect(
        db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
          "ezshop-media",
          "44444444-4444-4444-8444-444444444444/agent.png",
        ]),
      ).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
    await user(idB);
    await db.exec("set role authenticated");
    try {
      expect(
        (await db.query("select * from storage.objects")).rows,
      ).toHaveLength(0);
    } finally {
      await db.exec("reset role");
    }
    await user("");
    await db.exec("set role anon");
    try {
      await expect(
        db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
          "ezshop-media",
          "anonymous.png",
        ]),
      ).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
    await db.exec(
      readFileSync("supabase/migrations/202611040003_media.sql", "utf8"),
    );
    expect(
      (await db.query("select * from storage.buckets where id='ezshop-media'"))
        .rows,
    ).toHaveLength(1);
  });
});
