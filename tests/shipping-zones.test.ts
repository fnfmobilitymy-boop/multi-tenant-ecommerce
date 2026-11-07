import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111";
let mid: number, pid: number;
const user = async (id: string) => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
};
const call = async (route: string, payload: any = {}) =>
  (
    await db.query<{ v: any }>("select public.ezshop_api($1,$2::jsonb) v", [
      route,
      JSON.stringify(payload),
    ])
  ).rows[0].v;
const save = async (extra: any = {}) => {
  await user(owner);
  return call("settings", {
    name: "Zones",
    phone: "",
    description: "",
    shipping_fee: 700,
    courier: "Lalamove",
    ...extra,
  });
};
const rule = (state = "", city = "", postcode_prefix = "", fee = 0) => ({
  state,
  city,
  postcode_prefix,
  fee,
});
const address = {
  country: "MY",
  state: "Sabah",
  city: "Kota Kinabalu",
  postcode: "88700",
};
const quote = async (extra: any = {}) =>
  call("shipping-quote", {
    slug: "zones",
    items: [{ id: pid, quantity: 1 }],
    ...address,
    ...extra,
  });
beforeAll(async () => {
  await db.exec(
    readFileSync("tests/fixtures/postgres-backup-init.sql", "utf8"),
  );
  for (const f of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("supabase/migrations/" + f, "utf8"));
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
    [
      owner,
      "zones@example.test",
      JSON.stringify({ name: "Zones", slug: "zones" }),
    ],
  );
  await user(owner);
  mid = (await call("dashboard")).merchant.id;
  await call("products", {
    name: "Item",
    price: 1000,
    stock: 30,
    published: 1,
  });
  pid = (await call("dashboard")).products[0].id;
}, 30000);
afterAll(() => db.close());
it("州、城市、邮编优先匹配，免邮0不回退默认费；无匹配沿用默认费", async () => {
  await save({
    shipping_rules: [
      rule("Sabah", "", "", 1500),
      rule("Selangor", "", "", 900),
      rule("", "Shah Alam", "", 500),
      rule("", "", "401", 0),
    ],
  });
  expect((await quote()).shipping).toBe(1500);
  expect(
    (await quote({ state: "Kuala Lumpur", city: "KL", postcode: "50000" }))
      .shipping,
  ).toBe(700);
  expect(
    (await quote({ state: "Selangor", city: "shah ALAM", postcode: "40200" }))
      .shipping,
  ).toBe(500);
  expect(
    (await quote({ state: "Selangor", city: "Shah Alam", postcode: "40150" }))
      .shipping,
  ).toBe(0);
  const pending = await call("shipping-quote", {
    slug: "zones",
    items: [{ id: pid, quantity: 1 }],
  });
  expect(pending).toMatchObject({
    subtotal: 1000,
    shipping: null,
    total: null,
    destination_required: true,
  });
});
it("非法、重复规则及跨国家地址被拒绝，不信任浏览器伪造运费", async () => {
  for (const rules of [
    [rule("Sabah", "", "", -1)],
    [rule("Sabah", "", "", 1.5)],
    [{ ...rule(), fee: "0" }],
    [rule(), rule()],
    Array(51).fill(rule()),
  ])
    await expect(save({ shipping_rules: rules })).rejects.toThrow();
  await expect(quote({ country: "SG" })).rejects.toThrow();
  const input = {
    slug: "zones",
    ...address,
    items: [{ id: pid, quantity: 1 }],
    customer: "Buyer",
    email: "buyer@example.test",
    phone: "0123456789",
    address: "Address",
    checkout_key: "zones-shipping-key-00000001",
    shipping: 0,
    total: 1,
    currency: "MYR",
  };
  await expect(
    call("checkout", { ...input, expected_shipping: 0 }),
  ).rejects.toThrow("邮费已更新");
  const o = await call("checkout", { ...input, expected_shipping: 1500 });
  expect(o.total).toBe(2500);
  const old = (
    await db.query<{ shipping: number }>(
      "select shipping from ezshop.orders where reference=$1",
      [o.reference],
    )
  ).rows[0];
  expect(old.shipping).toBe(1500);
  await save({ shipping_rules: [rule("Sabah", "", "", 2100)] });
  const retry = await call("checkout", input);
  expect(retry.total).toBe(2500);
  expect(
    (
      await db.query<{ stock: number }>(
        "select stock from ezshop.products where id=$1",
        [pid],
      )
    ).rows[0].stock,
  ).toBe(29);
});
it("旧订单运费快照保留，规则可删除恢复默认费；私有RPC不可绕过", async () => {
  await save({ shipping_rules: [] });
  expect((await quote()).shipping).toBe(700);
  expect((await call("dashboard")).merchant.shipping_rules_enabled).toBe(true);
  const ready = (
    await db.query<{ v: any }>("select public.ezshop_shipping_zones_status() v")
  ).rows[0].v;
  expect(ready.ready).toBe(true);
  await expect(
    db.exec(
      "set role authenticated;select public.ezshop_pre_zone_api('settings','{}');",
    ),
  ).rejects.toThrow();
  await db.exec("reset role");
  await user("");
  await expect(call("settings", { shipping_rules: [] })).rejects.toThrow();
});
it("各国店铺沿用自己的币种，越南盾整数运费及免邮规则正确", async () => {
  let n = 2;
  for (const [country, currency, fee] of [
    ["SG", "SGD", 250],
    ["TH", "THB", 3500],
    ["KH", "KHR", 100000],
    ["KH", "USD", 500],
    ["VN", "VND", 50000],
  ] as const) {
    const id = String(n++).repeat(8) + "-2222-4222-8222-222222222222";
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        country + currency + "@example.test",
        JSON.stringify({
          name: currency,
          slug: "zones-" + currency.toLowerCase(),
          country_code: country,
          currency,
        }),
      ],
    );
    await user(id);
    await call("dashboard");
    await call("products", {
      name: "Item",
      price: currency === "VND" ? 100000 : 1000,
      stock: 3,
      currency,
    });
    const d = await call("dashboard");
    const state = country === "SG" ? "" : "Area";
    await call("settings", {
      name: currency,
      phone: "",
      description: "",
      shipping_fee: 0,
      shipping_rules: [
        rule(state, "Capital", "", fee),
        rule(state, "Free City", "", 0),
      ],
    });
    const payload = {
      slug: d.merchant.slug,
      items: [{ id: d.products[0].id, quantity: 1 }],
      country,
      state,
      city: "Capital",
      postcode: country === "SG" ? "018956" : "10000",
    };
    expect((await call("shipping-quote", payload)).shipping).toBe(fee);
    expect(
      (await call("shipping-quote", { ...payload, city: "Free City" }))
        .shipping,
    ).toBe(0);
  }
});
