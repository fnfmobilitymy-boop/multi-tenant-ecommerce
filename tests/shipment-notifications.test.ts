import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
import { notificationMessage } from "../supabase/functions/_shared/mail-template";
const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
let oid: number, pid: number;
const user = async (id: string) => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
};
const call = async (fn: string, route: string, payload: any = {}) =>
  (
    await db.query<{ v: any }>(`select public.${fn}($1,$2::jsonb) v`, [
      route,
      JSON.stringify(payload),
    ])
  ).rows[0].v;
const main = (route: string, payload: any = {}) =>
  call("ezshop_api", route, payload);
const mail = (route: string, payload: any = {}) =>
  call("ezshop_mail_api", route, payload);
async function service<T>(fn: () => Promise<T>) {
  await db.exec(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
  try {
    return await fn();
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','',false)");
  }
}
beforeAll(async () => {
  await db.exec(
    readFileSync("tests/fixtures/postgres-backup-init.sql", "utf8"),
  );
  for (const f of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("supabase/migrations/" + f, "utf8"));
  for (const id of [owner, other]) {
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        id + "@example.test",
        JSON.stringify({
          name: "Ship",
          slug: id === owner ? "ship-notice" : "other-ship",
        }),
      ],
    );
    await user(id);
    await main("dashboard");
  }
  await user(owner);
  await main("products", { name: "Item", price: 1000, stock: 3 });
  pid = (await main("dashboard")).products[0].id;
  await main("settings", {
    name: "Ship",
    phone: "",
    description: "",
    shipping_fee: 500,
  });
  await user("");
  const o = await main("checkout", {
    slug: "ship-notice",
    customer: "Buyer",
    email: "buyer@example.test",
    phone: "0123456789",
    address: "123 Address",
    state: "Selangor",
    city: "Shah Alam",
    postcode: "40150",
    locale: "vi",
    checkout_key: "shipment-notification-test-key-0001",
    items: [{ id: pid, quantity: 1 }],
  });
  await user(owner);
  oid = (await main("dashboard")).orders.find(
    (row: any) => row.reference === o.reference,
  ).id;
}, 30000);
afterAll(() => db.close());
it("未付款或其他商家不能登记发货；真实发货仅入队一次，不重复扣库存", async () => {
  await expect(
    main("orders/ship", { id: oid, carrier: "Lalamove", tracking: "LM-01" }),
  ).rejects.toThrow();
  await main("orders/paid", { id: oid });
  await user(other);
  await expect(
    main("orders/ship", { id: oid, carrier: "Lalamove", tracking: "LM-01" }),
  ).rejects.toThrow();
  await user(owner);
  for (let i = 0; i < 2; i++)
    await main("orders/ship", {
      id: oid,
      carrier: "Lalamove",
      tracking: "LM-01",
    });
  const jobs = (await main("notifications")).jobs.filter(
    (j: any) => j.kind === "shipment",
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0].status).toBe("queued");
  expect((await main("dashboard")).products[0].stock).toBe(2);
  await expect(
    main("orders/ship", { id: oid, carrier: "Other", tracking: "DIFFERENT" }),
  ).rejects.toThrow();
});
it("通知声明、重试与快递资料只来自服务器，普通用户不能认领任务", async () => {
  await expect(mail("mail/claim")).rejects.toThrow();
  await db.exec(
    "update ezshop.notification_jobs set status='sent' where kind='receipt'",
  );
  const job = await service(() => mail("mail/claim", { tracking: "FORGED" }));
  expect(job).toMatchObject({
    kind: "shipment",
    locale: "vi",
    carrier: "Lalamove",
    tracking: "LM-01",
    shipping: 500,
    currency: "MYR",
    total: 1500,
  });
  await service(() =>
    mail("mail/finish", {
      id: job.id,
      status: "failed",
      error: "fixture failure",
    }),
  );
  const retry = await service(() => mail("mail/claim"));
  expect(retry.id).toBe(job.id);
  expect(retry.attempts).toBe(2);
  await service(() =>
    mail("mail/finish", {
      id: job.id,
      status: "sent",
      provider_id: "fixture-provider-accepted",
    }),
  );
  expect(await service(() => mail("mail/claim"))).toBeNull();
});
it("退款后的未发通知会跳过，内部旧RPC仍然受保护", async () => {
  await db.exec(
    "update ezshop.notification_jobs set status='failed' where kind='shipment';update ezshop.orders set status='refunded' where id=" +
      oid,
  );
  expect(await service(() => mail("mail/claim"))).toBeNull();
  expect(
    (await main("notifications")).jobs.find((j: any) => j.kind === "shipment")
      .status,
  ).toBe("skipped");
  const ready = (
    await db.query<{ v: any }>(
      "select public.ezshop_shipment_notice_status() v",
    )
  ).rows[0].v;
  expect(ready.ready).toBe(true);
  await expect(
    db.exec(
      "set role service_role;select public.ezshop_pre_ship_mail_api('mail/claim','{}');",
    ),
  ).rejects.toThrow();
  await db.exec("reset role");
});
it("六语发货通知包含运单，HTML转义外部文字并保留VND整数金额", () => {
  const input = {
    kind: "shipment",
    store_name: "Store",
    reference: "EZ-SHIP",
    currency: "VND" as const,
    carrier: "<script>carrier</script>",
    tracking: "LM-01 <img>",
    shipping: 10000,
    total: 110000,
    items: [{ name: "Item", quantity: 1, price: 100000 }],
  };
  for (const locale of ["zh", "en", "ms", "th", "km", "vi"]) {
    const out = notificationMessage({ ...input, locale });
    expect(out.text).toContain("LM-01");
    expect(out.text).toContain("VND 110000");
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  }
  expect(() => notificationMessage({ ...input, tracking: "" })).toThrow(
    "Invalid shipment",
  );
});
