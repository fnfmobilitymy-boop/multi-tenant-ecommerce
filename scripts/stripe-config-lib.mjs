import { validateProCheckout } from "../supabase/functions/_shared/payment-security.ts";
import { publicConfig } from "./live-check-lib.mjs";
export const subscriptionEvents = [
  "checkout.session.completed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];
export async function validateStripeConfiguration(stripe, env) {
  const mode = env.STRIPE_SECRET_KEY?.startsWith("sk_live_")
    ? "live"
    : env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
      ? "test"
      : null;
  if (
    !mode ||
    !env.STRIPE_PRO_PRICE_ID ||
    !env.STRIPE_PRO_TAX_RATE_ID ||
    !env.STRIPE_WEBHOOK_SECRET
  )
    throw new Error("Stripe 必需配置缺失");
  const { root } = publicConfig(env);
  const price = await stripe.prices.retrieve(env.STRIPE_PRO_PRICE_ID);
  const tax = await stripe.taxRates.retrieve(env.STRIPE_PRO_TAX_RATE_ID);
  validateProCheckout(price, tax);
  if (
    price.livemode !== (mode === "live") ||
    tax.livemode !== (mode === "live")
  )
    throw new Error("Stripe 价格、税率与密钥模式不一致");
  let cursor;
  let found = false;
  do {
    const page = await stripe.webhookEndpoints.list({
      limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    });
    found ||= page.data.some(
      (endpoint) =>
        endpoint.url === root + "/functions/v1/stripe-webhook" &&
        endpoint.status === "enabled" &&
        !endpoint.connect &&
        subscriptionEvents.every(
          (event) =>
            endpoint.enabled_events.includes(event) ||
            endpoint.enabled_events.includes("*"),
        ),
    );
    cursor = page.has_more && page.data.length ? page.data.at(-1).id : null;
  } while (cursor && !found);
  if (!found) throw new Error("Stripe Webhook 地址、状态或订阅事件配置不完整");
  return {
    mode,
    price_valid: true,
    tax_valid: true,
    webhook_configured: true,
    payment_verified: false,
  };
}
