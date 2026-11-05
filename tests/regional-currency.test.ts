import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
import { money } from "../src/api";
import {
  countryCurrencies,
  currencyFactor,
  suggestCountry,
  toMinor,
} from "../supabase/functions/_shared/currencies";
const db = new PGlite(),
  buyer = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const shops: {
  owner: string;
  country: string;
  currency: string;
  mid: number;
  pid: number;
  order: any;
}[] = [];
async function user(id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function call(fn: string, route: string, payload: any = {}) {
  return (
    await db.query<{ body: any }>(`select public.${fn}($1,$2::jsonb) body`, [
      route,
      JSON.stringify(payload),
    ])
  ).rows[0].body;
}
const main = (route: string, payload: any = {}) =>
  call("ezshop_api", route, payload);
beforeAll(async () => {
  await db.exec(
    readFileSync("tests/fixtures/postgres-backup-init.sql", "utf8"),
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'buyer@example.test',now())",
    [buyer],
  );
  let counter = 1;
  for (const [country, choices] of Object.entries(countryCurrencies))
    for (const currency of choices) {
      const owner = `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
      await db.query(
        "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3,now())",
        [
          owner,
          owner + "@example.test",
          JSON.stringify({
            name: currency + " store",
            slug: "region-" + currency.toLowerCase(),
            country_code: country,
            currency,
          }),
        ],
      );
      await user(owner);
      const m = (await main("dashboard")).merchant;
      expect(m.currency).toBe(currency);
      expect(m.country_code).toBe(country);
      await main("products", {
        name: "Regional Item",
        price: currency === "VND" ? 50000 : 1000,
        unit_cost: currency === "VND" ? 20000 : 400,
        stock: 20,
        published: 1,
        currency,
      });
      const pid = (await main("dashboard")).products[0].id;
      await main("settings", {
        name: m.name,
        shipping_fee: currency === "VND" ? 10000 : 200,
        currency,
        country_code: country,
      });
      shops.push({ owner, country, currency, mid: m.id, pid, order: null });
    }
}, 30000);
afterAll(() => db.close());
it("地区建议使用设备线索而不把界面语言当作货币，VND零小数严格换算", () => {
  expect(suggestCountry("Asia/Singapore", ["zh-CN"])).toBe("SG");
  expect(suggestCountry("Asia/Phnom_Penh", ["en-US"])).toBe("KH");
  expect(suggestCountry("Etc/UTC", ["en-SG"])).toBe("SG");
  expect(toMinor("50000", "VND")).toBe(50000);
  expect(() => toMinor("1.5", "VND")).toThrow();
  expect(toMinor("10.01", "SGD")).toBe(1001);
  expect(() => toMinor("1.001", "USD")).toThrow();
  expect(money(50000, "en", "VND")).toContain("50,000");
  expect(money(1000, "en", "SGD")).toContain("10.00");
});
it("六种店铺币种由服务器决定，买家伪造币种无效；本地地址校验及订单币种快照正确", async () => {
  for (const shop of shops) {
    await user(buyer);
    if(shop.currency!=="MYR")await expect(main("checkout",{slug:"region-"+shop.currency.toLowerCase(),currency:"MYR"})).rejects.toThrow("币种已变化");
    const postcode =
      shop.country === "SG"
        ? "018956"
        : shop.country === "KH"
          ? "120101"
          : "10100";
    const order = await main("checkout", {
      slug: "region-" + shop.currency.toLowerCase(),
      currency: shop.currency,
      customer: "Buyer",
      email: "buyer@example.test",
      phone: "0123456789",
      address: "Local address",
      city: "Local city",
      state: shop.country === "MY" ? "Kuala Lumpur" : "Local region",
      postcode,
      country: shop.country,
      items: [{ id: shop.pid, quantity: 2 }],
      checkout_key: "regional_checkout_key_" + shop.currency,
    });
    shop.order = order;
    expect(order.currency).toBe(shop.currency);
    expect(order.total).toBe(shop.currency === "VND" ? 110000 : 2200);
    const result = await main("order-result", {
      slug: "region-" + shop.currency.toLowerCase(),
      reference: order.reference,
      token: order.access_token,
    });
    expect(result.order.currency).toBe(shop.currency);
    expect(result.order.country_code).toBe(shop.country);
    await expect(
      db.query("update ezshop.orders set currency='BAD' where reference=$1", [
        order.reference,
      ]),
    ).rejects.toThrow();
    await user(shop.owner);
    const oid = (await main("dashboard")).orders[0].id;
    await main("orders/paid", { id: oid });
    const report = await call("ezshop_books_api", "summary");
    expect(report.currency).toBe(shop.currency);
    expect(report.summary.receipts).toBe(order.total);
    const events = (
      await db.query<{ currency: string }>(
        "select currency from ezshop.finance_events where merchant_id=$1",
        [shop.mid],
      )
    ).rows;
    expect(events.every((x) => x.currency === shop.currency)).toBe(true);
  }
});
it("已有商品/交易后不能更换国家币种；金额写入的错误币种被拒绝且不留下支出", async () => {
  for (const shop of shops) {
    await user(shop.owner);
    await expect(
      main("settings", {
        name: "Changed",
        country_code: "KH",
        currency: shop.currency === "USD" ? "KHR" : "USD",
      }),
    ).rejects.toThrow("转换币种");
    if (shop.currency !== "MYR") {
      await expect(
        main("products", {
          name: "Bad currency",
          price: 100,
          stock: 1,
          published: 1,
          currency: "MYR",
        }),
      ).rejects.toThrow("币种已变化");
      const before = (
        await db.query(
          "select id from ezshop.finance_entries where merchant_id=$1",
          [shop.mid],
        )
      ).rows.length;
      await expect(
        call("ezshop_books_api", "entry/add", {
          kind: "expense",
          category: "operating",
          amount: 10,
          description: "Currency mismatch",
          occurred_on: "2026-01-01",
          request_key: "currency_test_reject_" + shop.currency,
          currency: "MYR",
        }),
      ).rejects.toThrow("币种已变化");
      expect(
        (
          await db.query(
            "select id from ezshop.finance_entries where merchant_id=$1",
            [shop.mid],
          )
        ).rows,
      ).toHaveLength(before);
    }
  }
});
it("购买记录跨店铺按币种分组，不把不同货币相加；店铺内统计使用相同币种", async () => {
  await user(buyer);
  const all = await call("ezshop_customer_api", "history");
  expect(all.summary.paid_total).toBeNull();
  expect(all.summary.refunded_total).toBeNull();
  expect(all.currency_totals).toHaveLength(6);
  for (const shop of shops) {
    const history = await call("ezshop_customer_api", "history", {
      slug: "region-" + shop.currency.toLowerCase(),
    });
    expect(history.summary.currency).toBe(shop.currency);
    expect(history.summary.paid_total).toBe(shop.order.total);
    expect(history.orders[0].currency).toBe(shop.currency);
  }
});
it("Stripe订单金额使用订单快照币种；平台Pro价格仍是MYR且匿名不可调用内部函数", async () => {
  const shop = shops.find((s) => s.currency === "SGD")!;
  await user(shop.owner);
  await db.query(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
  await call("ezshop_payment_api", "service/bind-account", {
    merchant_id: shop.mid,
    account_id: "acct_region_fixture",
  });
  await call("ezshop_payment_api", "service/account-status", {
    account_id: "acct_region_fixture",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
  });
  const order = await main("checkout", {
    slug: "region-sgd",
    currency:"SGD",
    customer: "Buyer",
    email: "buyer@example.test",
    phone: "0123456789",
    address: "SG",
    city: "Singapore",
    postcode: "018956",
    country: "SG",
    items: [{ id: shop.pid, quantity: 1 }],
    checkout_key: "regional_stripe_order_key_sgd",
  });
  const claim = await call("ezshop_payment_api", "service/order-claim", {
    reference: order.reference,
    token: order.access_token,
  });
  expect(claim.currency).toBe("sgd");
  expect(claim.amount).toBe(1200);
  await db.query("select set_config('request.jwt.claim.role','',false)");
  await db.exec("set role anon");
  await expect(
    db.exec("select public.ezshop_pre_region_api('dashboard','{}')"),
  ).rejects.toThrow();
  expect(
    (await db.query<{ body: any }>("select public.ezshop_region_status() body"))
      .rows[0].body.ready,
  ).toBe(true);
  await db.exec("reset role");
});

it("账本按店铺地区划分日期，不使用买家语言或统一马来西亚日期边界", async () => {
  const shop = shops.find((s) => s.currency === "THB")!;
  await user(shop.owner);
  await db.query(
    "update ezshop.finance_events set occurred_at='2026-11-05T16:30:00Z' where merchant_id=$1 and kind='payment'",
    [shop.mid],
  );
  const sameDay = await call("ezshop_books_api", "summary", {
    date: "2026-11-05",
  });
  expect(sameDay.summary.receipts).toBe(shop.order.total);
  expect(
    (await call("ezshop_books_api", "summary", { date: "2026-11-06" })).summary
      .receipts,
  ).toBe(0);
});

it("重复升级保留不同店铺币种及成交快照，不重新解释历史金额",async()=>{await db.exec(readFileSync('supabase/upgrade-after-004.sql','utf8'));for(const shop of shops){const row=(await db.query<{currency:string}>('select currency from ezshop.merchants where id=$1',[shop.mid])).rows[0];expect(row.currency).toBe(shop.currency);const order=(await db.query<{currency:string}>('select currency from ezshop.orders where reference=$1',[shop.order.reference])).rows[0];expect(order.currency).toBe(shop.currency);}});
