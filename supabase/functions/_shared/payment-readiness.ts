// Configuration presence is not proof of a successful charge or valid keys.
// Only booleans and the Stripe environment may leave this function.
export function paymentReadiness(read: (name: string) => string | undefined) {
  const key = read("STRIPE_SECRET_KEY") || "";
  const mode = key.startsWith("sk_test_")
    ? "test"
    : key.startsWith("sk_live_")
      ? "live"
      : "unconfigured";
  const configured =
    mode !== "unconfigured" &&
    !!read("STRIPE_PRO_PRICE_ID") &&
    !!read("STRIPE_PRO_TAX_RATE_ID") &&
    !!read("STRIPE_WEBHOOK_SECRET");
  return { mode, configured, payment_verified: false };
}
