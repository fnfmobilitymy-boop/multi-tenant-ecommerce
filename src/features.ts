// Stripe automation is deferred. A release must explicitly opt in only after
// provider configuration and payment/webhook verification are complete.
export const stripeAutomationEnabled =
  import.meta.env.VITE_STRIPE_AUTOMATION_ENABLED === "true";

// Merchant-provided receiving details do not require Stripe Connect.
export const stripeConnectEnabled =
  import.meta.env.VITE_STRIPE_CONNECT_ENABLED === "true";
