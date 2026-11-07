// Optional shop order payments only. Platform Pro always uses manual approval;
// this legacy environment flag cannot enable automatic Pro subscriptions.
export const stripeAutomationEnabled =
  import.meta.env.VITE_STRIPE_AUTOMATION_ENABLED === "true";

// Merchant-provided receiving details do not require Stripe Connect.
export const stripeConnectEnabled =
  import.meta.env.VITE_STRIPE_CONNECT_ENABLED === "true";
