import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
const db = new PGlite();
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let mid: number, pid: number;
async function user(id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function call(name: string, route: string, payload: unknown = {}) {
  return (
    await db.query<{ body: any }>(`select public.${name}($1,$2::jsonb) body`, [
      route,
      JSON.stringify(payload),
    ])
  ).rows[0].body;
}
const main = (route: string, payload: unknown = {}) =>
    call("ezshop_api", route, payload),
  pay = (route: string, payload: unknown = {}) =>
    call("ezshop_payment_api", route, payload);
async function service<T>(fn: () => Promise<T>) {
  await db.query(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
  try {
    return await fn();
  } finally {
    await db.query("select set_config('request.jwt.claim.role','',false)");
  }
}
beforeAll(async () => {
  await db.exec(
    `create role anon;create role authenticated;create role service_role;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(regexp_replace(name,'/[^/]*$',''),'/') $$;grant usage on schema auth,storage to anon,authenticated;grant select,insert,update,delete on storage.objects to authenticated;`,
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  await db.query("insert into auth.users values($1,$2,$3),($4,$5,$6)", [
    owner,
    "pay@example.test",
    JSON.stringify({ name: "Pay Store", slug: "pay-store" }),
    other,
    "other@example.test",
    JSON.stringify({ name: "Other", slug: "other-store" }),
  ]);
  await user(owner);
  mid = (await main("dashboard")).merchant.id;
  await main("products", {
    name: "Product",
    price: 1000,
    stock: 100,
    published: 1,
  });
  pid = (await main("dashboard")).products[0].id;
  await user(other);
  await main("dashboard");
}, 30000);
afterAll(() => db.close());
async function order(suffix: string) {
  await user("");
  return main("checkout", {
    slug: "pay-store",
    customer: "Buyer",
    email: "buyer@example.test",
    phone: "0123456789",
    address: "KL",
    items: [{ id: pid, quantity: 1 }],
    checkout_key: "payment-order-key-" + suffix + "-123456789",
  });
}
describe("支付与订阅受控数据库接口", () => {
  it("商家或匿名用户不能自行开通收款或伪造付款", async () => {
    await user(owner);
    await expect(
      pay("service/bind-account", {
        merchant_id: mid,
        account_id: "acct_fixture",
        role: "service_role",
      }),
    ).rejects.toThrow();
    await user("");
    await expect(pay("owner-status")).rejects.toThrow();
    await expect(
      pay("service/payment-completed", { event_id: "evt_fake" }),
    ).rejects.toThrow();
    expect(
      (await pay("store-options", { slug: "pay-store" })).online_enabled,
    ).toBe(false);
  });
  it("服务端绑定 Connect 后，订单金额来自数据库且会话幂等", async () => {
    await service(() =>
      pay("service/bind-account", {
        merchant_id: mid,
        account_id: "acct_fixture",
      }),
    );
    await service(() =>
      pay("service/account-status", {
        account_id: "acct_fixture",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      }),
    );
    const o = await order("valid");
    const claim = await service(() =>
      pay("service/order-claim", {
        reference: o.reference,
        token: o.access_token,
        amount: 1,
      }),
    );
    expect(claim.amount).toBe(1000);
    expect(
      (
        await service(() =>
          pay("service/order-claim", {
            reference: o.reference,
            token: o.access_token,
          }),
        )
      ).id,
    ).toBe(claim.id);
    await service(() =>
      pay("service/save-order-session", {
        attempt_id: claim.id,
        session_id: "cs_valid",
      }),
    );
    const event = {
      event_id: "evt_valid",
      session_id: "cs_valid",
      account_id: "acct_fixture",
      amount: 1000,
      currency: "myr",
      payment_intent: "pi_fixture",
    };
    await service(() => pay("service/payment-completed", event));
    expect(
      (await service(() => pay("service/payment-completed", event))).duplicate,
    ).toBe(true);
    await user(owner);
    const d = await main("dashboard");
    expect(d.orders[0].status).toBe("paid");
    expect((await main("notifications")).jobs).toHaveLength(1);
    await expect(
      pay("order-summary", {
        slug: "pay-store",
        reference: o.reference,
        token: "wrong",
      }),
    ).rejects.toThrow();
  });
  it("金额不符或订单已取消时进入核查，不能自动标记付款", async () => {
    const o = await order("mismatch");
    const claim = await service(() =>
      pay("service/order-claim", {
        reference: o.reference,
        token: o.access_token,
      }),
    );
    await service(() =>
      pay("service/save-order-session", {
        attempt_id: claim.id,
        session_id: "cs_wrong",
      }),
    );
    expect(
      (
        await service(() =>
          pay("service/payment-completed", {
            event_id: "evt_wrong",
            session_id: "cs_wrong",
            account_id: "acct_fixture",
            amount: 1,
            currency: "myr",
          }),
        )
      ).requires_review,
    ).toBe(true);
    await expect(
      service(() =>
        pay("service/order-claim", {
          reference: o.reference,
          token: o.access_token,
        }),
      ),
    ).rejects.toThrow("核查");
    await user(owner);
    expect((await main("dashboard")).orders[0].status).toBe("pending");
    const review = (await pay("owner-status")).reviews[0];
    await user(other);
    await expect(
      pay("resolve-review", { id: review.id, resolution: "not permitted" }),
    ).rejects.toThrow();
    await user(owner);
    await main("orders/cancel", { id: claim.order_id });
    expect(
      (
        await service(() =>
          pay("service/payment-completed", {
            event_id: "evt_after_cancel",
            session_id: "cs_wrong",
            account_id: "acct_fixture",
            amount: 1000,
            currency: "myr",
          }),
        )
      ).requires_review,
    ).toBe(true);
    await user("");
    expect(
      (
        await pay("order-summary", {
          slug: "pay-store",
          reference: o.reference,
          token: o.access_token,
        })
      ).requires_review,
    ).toBe(true);
  });
  it("实际全额退款才回冲订单；重复回调不重复处理，部分退款需核查", async () => {
    const o = await order("refund");
    const claim = await service(() =>
      pay("service/order-claim", {
        reference: o.reference,
        token: o.access_token,
      }),
    );
    await service(() =>
      pay("service/save-order-session", {
        attempt_id: claim.id,
        session_id: "cs_refund",
      }),
    );
    await service(() =>
      pay("service/payment-completed", {
        event_id: "evt_pay_refund",
        session_id: "cs_refund",
        account_id: "acct_fixture",
        amount: 1000,
        currency: "myr",
        payment_intent: "pi_refund",
      }),
    );
    const refund = {
      event_id: "evt_refund_partial",
      account_id: "acct_fixture",
      payment_intent: "pi_refund",
      kind: "refund",
      charge_id: "ch_refund",
      currency: "myr",
      amount: 1000,
      refunded: 200,
    };
    await service(() => pay("service/charge-adjustment", refund));
    await user(owner);
    expect((await main("dashboard")).orders[0].status).toBe("paid");
    const stockBefore = (await main("dashboard")).products[0].stock;
    const full = { ...refund, event_id: "evt_refund_full", refunded: 1000 };
    await service(() => pay("service/charge-adjustment", full));
    expect((await main("dashboard")).orders[0].status).toBe("refunded");
    expect(
      (await service(() => pay("service/charge-adjustment", full))).duplicate,
    ).toBe(true);
    expect((await main("dashboard")).products[0].stock).toBe(stockBefore); // Refund never claims returned goods.
  });
  it("Pro只能人工审批，服务端旧账单回调不能开通、续期或撤销", async () => {
    await user(owner);
    const before = (await main("dashboard")).merchant.plan;
    await expect(
      pay("service/subscription-sync", {
        merchant_id: mid,
        invoice_paid: true,
        role: "service_role",
      }),
    ).rejects.toThrow();
    for (const route of [
      "service/bind-customer",
      "service/billing-claim",
      "service/save-billing-session",
    ]) {
      await expect(
        service(() => pay(route, { merchant_id: mid, price_id: "price_pro" })),
      ).rejects.toThrow("人工审核");
    }
    for (const status of ["active", "canceled", "past_due"]) {
      const result = await service(() =>
        pay("service/subscription-sync", {
          merchant_id: mid,
          status,
          invoice_paid: true,
        }),
      );
      expect(result.ignored).toBe(true);
      expect((await main("dashboard")).merchant.plan).toBe(before);
    }
    expect((await pay("owner-status")).automatic_pro_enabled).toBe(false);
    const state = (
      await db.query<{ body: any }>(
        "select public.ezshop_manual_billing_status() body",
      )
    ).rows[0].body;
    expect(state.ready).toBe(true);
    await expect(
      db.exec(
        "set role service_role;select public.ezshop_pre_manual_payment_api('service/subscription-sync','{}');",
      ),
    ).rejects.toThrow();
    await db.exec("reset role");
  });
  it("规格来自数据库，订单保留成交规格，重试及其他商家不能改写", async () => {
    await user(owner);
    await main("products", {
      name: "Shirt",
      price: 2500,
      stock: 4,
      variant: "黑色 / M",
    });
    let product = (await main("dashboard")).products[0];
    await user("");
    expect(
      (await main("store", { slug: "pay-store" })).products.find(
        (p: any) => p.id === product.id,
      ).variant,
    ).toBe("黑色 / M");
    const request = {
      slug: "pay-store",
      customer: "Buyer",
      email: "buyer@example.test",
      phone: "0123456789",
      address: "KL",
      checkout_key: "variant-order-key-1234567890",
      items: [{ id: product.id, quantity: 1 }],
    };
    const order = await main("checkout", request);
    await user(owner);
    product = (await main("dashboard")).products[0];
    await main("products/update", { ...product, variant: "白色 / L" });
    await user(other);
    await expect(
      main("products/update", {
        ...product,
        version: product.version + 1,
        variant: "Wrong store",
      }),
    ).rejects.toThrow();
    await user("");
    await main("checkout", request);
    const result = await main("order-result", {
      slug: "pay-store",
      reference: order.reference,
      token: order.access_token,
    });
    expect(result.items[0].name).toBe("Shirt · 黑色 / M");
    expect(
      (await main("store", { slug: "pay-store" })).products.find(
        (p: any) => p.id === product.id,
      ).variant,
    ).toBe("白色 / L");
  });

  it("多语言商品按商家授权保存，订单快照和联系资料不因切换或编辑改变", async () => {
    await user(owner);
    const versions = {
      en: {
        name: "English Shirt",
        description: "English description",
        variant: "Black / M",
      },
      vi: { name: "Áo đẹp", description: "Mô tả", variant: "Đen / M" },
    };
    await main("products", {
      name: "原文商品",
      price: 1500,
      stock: 8,
      variant: "黑色 / M",
      content_translations: versions,
    });
    let product = (await main("dashboard")).products[0];
    expect(product.content_translations.en.name).toBe("English Shirt");
    await expect(
      main("products", {
        name: "Invalid",
        price: 100,
        stock: 1,
        content_translations: { en: { price: "1" } },
      }),
    ).rejects.toThrow("多语言");
    await user(other);
    await expect(
      main("products/update", {
        ...product,
        content_translations: { en: { name: "foreign edit" } },
      }),
    ).rejects.toThrow();
    await user("");
    const visible = await main("store", { slug: "pay-store" });
    expect(visible.products[0].content_translations.vi.name).toBe("Áo đẹp");
    const request = {
      slug: "pay-store",
      customer: "สมชาย",
      phone: "0123456789",
      email: "buyer@example.test",
      address: "Địa chỉ gốc 123",
      locale: "vi",
      checkout_key: "translated-checkout-key-123456789",
      items: [{ id: product.id, quantity: 1 }],
    };
    const order = await main("checkout", request);
    await user(owner);
    product = (await main("dashboard")).products[0];
    await main("products/update", {
      ...product,
      content_translations: { vi: { name: "Changed later" } },
    });
    const stored = (await main("dashboard")).orders[0];
    expect(stored.customer).toBe("สมชาย");
    expect(stored.address).toBe("Địa chỉ gốc 123");
    expect(stored.locale).toBe("vi");
    expect(stored.total).toBe(1500);
    await user("");
    await main("checkout", { ...request, locale: "en" });
    const result = await main("order-result", {
      slug: "pay-store",
      reference: order.reference,
      token: order.access_token,
    });
    expect(result.items[0].content_translations.vi.name).toBe("Áo đẹp");
    expect(result.items[0].content_translations.en.name).toBe("English Shirt");
  });
  it("外部翻译额度只属于当前商家，匿名和超额请求无法通过", async () => {
    await user("");
    await expect(
      db.query("select public.ezshop_translation_access($1,$2)", [
        "product",
        1,
      ]),
    ).rejects.toThrow();
    await user(owner);
    const claim = () =>
      db.query("select public.ezshop_translation_access($1,$2)", [
        "product",
        5000,
      ]);
    for (let i = 0; i < 12; i++) await claim();
    await expect(claim()).rejects.toThrow("上限");
    await user(other);
    await expect(claim()).resolves.toBeTruthy();
  });
});

describe("平台自填金额订阅与安全上线检查", () => {
  it("平台配置只允许管理员，TRON 地址必须通过校验和", async () => {
    await user(other);
    await expect(
      call("ezshop_platform_billing_api", "settings"),
    ).rejects.toThrow();
    await db.query("update ezshop.merchants set is_admin=true where id=$1", [
      mid,
    ]);
    await user(owner);
    const config = {
      bank_enabled: true,
      bank_holder: "Test Platform",
      bank_account: "11112222333",
      tng_enabled: true,
      tng_holder: "Test Wallet",
      tng_identifier: "9988111122223",
      tng_qr: "",
      usdt_enabled: false,
      usdt_address: "",
      stripe_enabled: true,
      stripe_link: "https://buy.stripe.com/testOnlyFixture",
    };
    const validAddress = (
      await db.query<{ valid: boolean }>(
        "select ezshop.valid_tron_address('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb') valid",
      )
    ).rows[0].valid;
    expect(validAddress).toBe(true);
    await call("ezshop_platform_billing_api", "save", config);
    expect(
      (await call("ezshop_platform_billing_api", "settings")).settings
        .stripe_enabled,
    ).toBe(false);
    const version = (await call("ezshop_platform_billing_api", "settings"))
      .settings.version;
    await call("ezshop_platform_billing_api", "save", config);
    expect(
      (await call("ezshop_platform_billing_api", "settings")).settings.version,
    ).toBe(version);
    await expect(
      call("ezshop_platform_billing_api", "save", {
        ...config,
        usdt_enabled: true,
        usdt_address: "T" + "1".repeat(33),
      }),
    ).rejects.toThrow("校验");
    const status = (
      await db.query<{ body: any }>(
        "select public.ezshop_release_status() body",
      )
    ).rows[0].body;
    expect(status.database_ready).toBe(true);
    expect(status.production_verified).toBe(false);
    expect(status).not.toHaveProperty("bank_account");
  });
  it("参考号或自填金额不会自动开通，审批需实际到账声明且到期会失效", async () => {
    await user(other);
    const api = (route: string, payload: any = {}) =>
      call("ezshop_platform_billing_api", route, payload);
    expect((await api("view")).options.stripe_link).toBe(false);
    await expect(
      api("create", { method: "stripe_link", amount: "105.89" }),
    ).rejects.toThrow("人工审核");
    const req = (
      await api("create", { method: "bank_transfer", amount: "19.90" })
    ).request;
    expect(req.instructions.account).toBe("11112222333");
    expect((await main("dashboard")).merchant.plan).toBe("free");
    await api("submit", { id: req.id, reference: "TEST-BANK-REFERENCE" });
    await api("submit", { id: req.id, reference: "TEST-BANK-REFERENCE" });
    expect((await main("dashboard")).merchant.plan).toBe("free");
    await expect(
      api("review", { id: req.id, status: "approved" }),
    ).rejects.toThrow();
    await user(owner);
    await expect(
      api("review", {
        id: req.id,
        status: "approved",
        actual_reference: "VERIFIED-BANK-TEST",
        actual_amount: "19.90",
        days: 30,
        verified: false,
      }),
    ).rejects.toThrow();
    await api("review", {
      id: req.id,
      status: "approved",
      actual_reference: "VERIFIED-BANK-TEST",
      actual_amount: "19.90",
      days: 30,
      verified: true,
    });
    await user(other);
    expect((await main("dashboard")).merchant.plan).toBe("pro");
    const grant = (await api("view")).paid_until;
    for (const status of ["active", "canceled"]) {
      await service(() =>
        pay("service/subscription-sync", {
          merchant_id: req.merchant_id,
          status,
          invoice_paid: true,
          period_end: 2100000000,
        }),
      );
      expect((await api("view")).paid_until).toBe(grant);
      expect((await main("dashboard")).merchant.plan).toBe("pro");
    }
    await user(owner);
    await expect(
      api("review", {
        id: req.id,
        status: "approved",
        actual_reference: "VERIFIED-BANK-TEST",
        actual_amount: "19.90",
        days: 30,
        verified: true,
      }),
    ).rejects.toThrow();
    await db.query(
      "update ezshop.manual_plan_grants set paid_until=now()-interval '1 minute' where merchant_id=(select id from ezshop.merchants where owner=$1)",
      [other],
    );
    await user(other);
    expect((await main("dashboard")).merchant.plan).toBe("free");
    await user("");
    await expect(api("view")).rejects.toThrow();
  });
  it("邮件任务使用订单语言及成交译文，普通商家不能调用发送接口", async () => {
    await user(other);
    await expect(
      db.exec(
        "set role authenticated;select public.ezshop_mail_api('mail/claim','{}')",
      ),
    ).rejects.toThrow();
    await db.exec("reset role");
    await user(owner);
    await main("products", {
      name: "Mail original",
      price: 1000,
      stock: 3,
      content_translations: { vi: { name: "Tên đã mua" } },
    });
    const product = (await main("dashboard")).products[0];
    await user("");
    const order = await main("checkout", {
      slug: "pay-store",
      customer: "Buyer",
      email: "buyer@example.test",
      phone: "0123456789",
      address: "KL",
      locale: "vi",
      checkout_key: "mail-language-order-key-123456",
      items: [{ id: product.id, quantity: 1 }],
    });
    await user(owner);
    const stored = (await main("dashboard")).orders.find(
      (o: any) => o.reference === order.reference,
    );
    await main("orders/paid", { id: stored.id });
    await db.exec(
      "update ezshop.notification_jobs set status='sent' where order_id<>" +
        stored.id,
    );
    const job = await service(() => call("ezshop_mail_api", "mail/claim"));
    expect(job.locale).toBe("vi");
    expect(job.items[0].name).toBe("Tên đã mua");
  });
});

it("七天试用固定截止；到期禁止经营及绕过入口，保留续费与已有订单查询", async () => {
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await db.query("insert into auth.users values($1,$2,$3)", [
    id,
    "trial@example.test",
    JSON.stringify({ name: "Trial", slug: "trial-store" }),
  ]);
  await user(id);
  const fresh = await main("dashboard");
  const merchant = fresh.merchant.id;
  expect(fresh.merchant.subscription_access).toBe(true);
  const duration = (
    await db.query<{ seconds: number }>(
      "select extract(epoch from (trial_ends_at-now()))::float8 seconds from ezshop.merchants where id=$1",
      [merchant],
    )
  ).rows[0].seconds;
  expect(duration).toBeGreaterThan(604700);
  expect(duration).toBeLessThanOrEqual(604800);
  await main("products", {
    name: "Trial product",
    price: 1000,
    stock: 3,
    published: 1,
  });
  const product = (await main("dashboard")).products[0];
  await user("");
  const placed = await main("checkout", {
    slug: "trial-store",
    customer: "Buyer",
    email: "buyer@example.test",
    phone: "0123456789",
    address: "KL",
    items: [{ id: product.id, quantity: 1 }],
    checkout_key: "trial_order_idempotency_00001",
  });
  await db.query(
    "update ezshop.merchants set trial_ends_at=now()-interval '1 minute',plan='pro' where id=$1",
    [merchant],
  );
  await user(id);
  const expired = await main("dashboard");
  expect(expired.merchant.subscription_access).toBe(false);
  expect(expired.products).toEqual([]);
  expect(expired.orders).toEqual([]);
  await expect(
    main("products", { name: "Bypass", price: 1000, stock: 3 }),
  ).rejects.toThrow("到期");
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select public.ezshop_can_upload_media() allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
  expect((await pay("owner-status")).trial_ends_at).toBeTruthy();
  expect(await call("ezshop_platform_billing_api", "view")).toHaveProperty(
    "options",
  );
  await db.exec("set role authenticated");
  await expect(
    call("ezshop_subscription_api", "products", {}),
  ).rejects.toThrow();
  await db.exec("reset role");
  await user("");
  const closed = await main("store", { slug: "trial-store" });
  expect(closed.products).toEqual([]);
  expect(closed.store.subscription_access).toBe(false);
  await expect(
    main("checkout", {
      slug: "trial-store",
      customer: "Buyer",
      email: "buyer@example.test",
      phone: "0123456789",
      address: "KL",
      items: [{ id: product.id, quantity: 1 }],
      checkout_key: "trial_order_idempotency_00002",
    }),
  ).rejects.toThrow("暂停");
  expect(
    (
      await main("order-result", {
        slug: "trial-store",
        reference: placed.reference,
        token: placed.access_token,
      })
    ).order.reference,
  ).toBe(placed.reference);
  await db.query(
    "insert into ezshop.billing_accounts(merchant_id,customer_id,status,invoice_paid,paid_through) values($1,'cus_trial_fixture',$2,true,now()+interval '1 month')",
    [merchant, "active"],
  );
  await user(id);
  expect((await main("dashboard")).merchant.subscription_access).toBe(true);
  await db.query(
    "update ezshop.billing_accounts set status='past_due',invoice_paid=false where merchant_id=$1",
    [merchant],
  );
  expect((await main("dashboard")).merchant.subscription_access).toBe(false);
  await user(owner);
});

it("商家自行填写银行资料，商家隔离且订单锁定当时账户，不自动标记已付款", async () => {
  await user(owner);
  const original = (await main("receiving")).receiving;
  const payload = {
    ...original,
    bank_enabled: true,
    bank_name: "Test Merchant Bank",
    holder: "Test Merchant Holder",
    account: "1234567890",
    instructions: "Use the order reference",
  };
  const first = (await main("receiving/save", payload)).receiving;
  expect(first.version).toBe(1);
  await expect(main("receiving/save", payload)).rejects.toThrow("已更新");
  await user(other);
  expect((await main("receiving")).receiving.account).toBe("");
  const publicStore = await main("store", { slug: "pay-store" });
  expect(JSON.stringify(publicStore)).not.toContain("1234567890");
  const placed = await order("bank-snapshot");
  expect(placed.status).toBe("pending");
  const result = await main("order-result", {
    slug: "pay-store",
    reference: placed.reference,
    token: placed.access_token,
  });
  expect(result.payment_instructions.bank.account).toBe("1234567890");
  expect(result.order.status).toBe("pending");
  await expect(
    main("order-result", {
      slug: "pay-store",
      reference: placed.reference,
      token: "wrong",
    }),
  ).rejects.toThrow();
  await user(owner);
  const changed = (
    await main("receiving/save", { ...first, account: "9999999999" })
  ).receiving;
  await user("");
  expect(
    (
      await main("order-result", {
        slug: "pay-store",
        reference: placed.reference,
        token: placed.access_token,
      })
    ).payment_instructions.bank.account,
  ).toBe("1234567890");
  expect((await order("bank-snapshot")).reference).toBe(placed.reference);
  await user(owner);
  await main("receiving/save", { ...changed, bank_enabled: false });
  const unconfigured = await order("bank-disabled");
  expect(
    (
      await main("order-result", {
        slug: "pay-store",
        reference: unconfigured.reference,
        token: unconfigured.access_token,
      })
    ).payment_instructions,
  ).toEqual({});
  await expect(main("receiving")).rejects.toThrow();
  await user(owner);
});

it("电子钱包、USDT和商家链接独立校验，停用银行资料不泄露也不伪造汇率或到账", async () => {
  await user(owner);
  const base = (await main("receiving")).receiving;
  await expect(
    main("receiving/save", {
      ...base,
      link_enabled: true,
      payment_link: "javascript:alert(1)",
    }),
  ).rejects.toThrow("HTTPS");
  await expect(
    main("receiving/save", {
      ...base,
      link_enabled: true,
      payment_link: "https://user:pass@example.test/pay",
    }),
  ).rejects.toThrow("HTTPS");
  await expect(
    main("receiving/save", {
      ...base,
      wallet_enabled: true,
      wallet_name: "Test Wallet",
      wallet_identifier: "",
      wallet_qr: "",
    }),
  ).rejects.toThrow("电子钱包");
  await expect(
    main("receiving/save", {
      ...base,
      usdt_enabled: true,
      usdt_network: null,
      usdt_address: "",
    }),
  ).rejects.toThrow("USDT");
  await expect(
    main("receiving/save", {
      ...base,
      usdt_enabled: true,
      usdt_network: "TRC20",
      usdt_address: "invalid",
    }),
  ).rejects.toThrow("USDT");
  await main("receiving/save", {
    ...base,
    bank_enabled: false,
    wallet_enabled: true,
    wallet_name: "Test Wallet",
    wallet_identifier: "test-wallet-id",
    usdt_enabled: true,
    usdt_network: "ERC20",
    usdt_address: "0x1111111111111111111111111111111111111111",
    link_enabled: true,
    payment_link: "https://checkout.stripe.com/c/pay/test-fixture",
  });
  const placed = await order("merchant-multiple-rails");
  const result = await main("order-result", {
    slug: "pay-store",
    reference: placed.reference,
    token: placed.access_token,
  });
  expect(result.payment_instructions).not.toHaveProperty("bank");
  expect(result.payment_instructions.wallet.identifier).toBe("test-wallet-id");
  expect(result.payment_instructions.usdt.network).toBe("ERC20");
  expect(result.payment_instructions.link).toBe(
    "https://checkout.stripe.com/c/pay/test-fixture",
  );
  expect(result.order.total).toBeGreaterThan(0);
  expect(result.order.status).toBe("pending");
  expect(result.payment_instructions).not.toHaveProperty("exchange_rate");
  await user(owner);
});
