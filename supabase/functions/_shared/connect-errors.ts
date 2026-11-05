// Match provider diagnostics internally; never expose raw Stripe errors, request
// bodies, API credentials or customer information to the browser or logs.
export function connectFailure(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const type = typeof value.type === "string" ? value.type : "";
  const message = typeof value.message === "string" ? value.message : "";
  let code = "connect_request_failed";
  let text = "商家收款开通失败，请联系平台核查Stripe请求日志。";
  const providerError = ["StripeInvalidRequestError", "StripePermissionError"].includes(type);
  if (providerError && /signed up for connect|sign up for connect|connect.{0,40}not (?:enabled|activated)/i.test(message)) {
    code = "connect_not_enabled";
    text = "平台尚未启用Stripe Connect，请先在Stripe测试或正式环境完成Connect设置。";
  } else if (providerError && /managing losses|responsible for.{0,30}losses|platform profile|platform.{0,30}(?:complete|setup|set up)|onboarding.{0,20}settings/i.test(message)) {
    code = "connect_platform_setup";
    text = "Stripe Connect平台设置尚未完成，请核对平台资料、责任及入驻设置。";
  } else if (providerError && /country.{0,70}(?:not supported|unsupported|not available)|not.{0,30}support.{0,30}country/i.test(message)) {
    code = "connect_country_unavailable";
    text = "Stripe Connect未允许当前平台为该国家开通收款，请核对平台与商家国家的支持范围。";
  }
  const requestId = typeof value.requestId === "string" && /^req_[A-Za-z0-9]{1,100}$/.test(value.requestId) ? value.requestId : undefined;
  return { code, error: text, ...(requestId ? { request_id: requestId } : {}) };
}
