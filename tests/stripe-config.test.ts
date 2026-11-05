import { it, expect } from "vitest";
import {
  validateStripeConfiguration,
  subscriptionEvents,
} from "../scripts/stripe-config-lib.mjs";
const env = {
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_PRO_PRICE_ID: "price_fixture",
  STRIPE_PRO_TAX_RATE_ID: "txr_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  VITE_SUPABASE_URL: "https://fixture.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_fixture",
};
function provider(changes: any = {}) {
  return {
    prices: {
      retrieve: async () => ({
        id: "price_fixture",
        active: true,
        currency: "myr",
        unit_amount: 9990,
        type: "recurring",
        recurring: { interval: "month", interval_count: 1 },
        tax_behavior: "exclusive",
        livemode: false,
        ...changes.price,
      }),
    },
    taxRates: {
      retrieve: async () => ({
        id: "txr_fixture",
        active: true,
        percentage: 6,
        inclusive: false,
        livemode: false,
        ...changes.tax,
      }),
    },
    webhookEndpoints: {
      list: async () => ({
        data: [
          {
            id: "we_fixture",
            url: "https://fixture.supabase.co/functions/v1/stripe-webhook",
            status: "enabled",
            connect: false,
            enabled_events: subscriptionEvents,
            ...changes.webhook,
          },
        ],
        has_more: false,
      }),
    },
  };
}
it("仅使用读取接口核实模式、固定月费、外加税和全部订阅事件，不声称真实交易通过", async () => {
  const result = await validateStripeConfiguration(provider(), env);
  expect(result).toEqual({
    mode: "test",
    price_valid: true,
    tax_valid: true,
    webhook_configured: true,
    payment_verified: false,
  });
  expect(JSON.stringify(result)).not.toContain("fixture");
});
it("拒绝错误价格、含税价格、跨模式以及错误或停用Webhook", async () => {
  for (const changes of [
    { price: { unit_amount: 1 } },
    { price: { tax_behavior: "inclusive" } },
    { tax: { percentage: 8 } },
    { tax: { inclusive: true } },
    { price: { livemode: true } },
    { webhook: { status: "disabled" } },
    { webhook: { url: "https://other.example/functions/v1/stripe-webhook" } },
    { webhook: { enabled_events: ["invoice.paid"] } },
    { webhook: { connect: true } },
  ])
    await expect(
      validateStripeConfiguration(provider(changes), env),
    ).rejects.toThrow();
});
it("翻页检查并接受Stripe全事件配置", async () => {
  const sdk = provider();
  let count = 0;
  sdk.webhookEndpoints.list = async () =>
    ++count === 1
      ? {
          data: [
            {
              id: "we_first",
              url: "https://old.example",
              status: "enabled",
              connect: false,
              enabled_events: [],
            },
          ],
          has_more: true,
        }
      : {
          data: [
            {
              id: "we_last",
              url: "https://fixture.supabase.co/functions/v1/stripe-webhook",
              status: "enabled",
              connect: false,
              enabled_events: ["*"],
            },
          ],
          has_more: false,
        };
  expect((await validateStripeConfiguration(sdk, env)).webhook_configured).toBe(
    true,
  );
  expect(count).toBe(2);
});
