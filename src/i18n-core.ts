import messages from "./locales/messages.json";
export const LANGUAGES = [
  { code: "zh", label: "中文", intl: "zh-CN" },
  { code: "en", label: "English", intl: "en-MY" },
  { code: "ms", label: "Bahasa Melayu", intl: "ms-MY" },
  { code: "th", label: "ไทย", intl: "th-TH" },
  { code: "km", label: "ខ្មែរ", intl: "km-KH" },
  { code: "vi", label: "Tiếng Việt", intl: "vi-VN" },
] as const;
export type Locale = (typeof LANGUAGES)[number]["code"];
export type Audience = "customer" | "merchant" | "platform";
export const allowedLanguages = (audience: Audience) =>
  audience === "platform"
    ? LANGUAGES.filter((l) => l.code === "zh" || l.code === "en")
    : LANGUAGES;
export function normalizeLocale(value: unknown, audience: Audience): Locale {
  return allowedLanguages(audience).some((l) => l.code === value)
    ? (value as Locale)
    : "zh";
}
export function intlLocale(locale: Locale) {
  return LANGUAGES.find((l) => l.code === locale)!.intl;
}
const catalog = messages as Record<string, string[]>;
export function translate(
  locale: Locale,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const index = LANGUAGES.findIndex((l) => l.code === locale);
  const message = locale === "zh" ? key : (catalog[key]?.[index - 1] ?? key);
  return message.replace(/\{([a-zA-Z][\w]*)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}
const translatedValues = new Set(Object.values(catalog).flat());
export function translateError(locale: Locale, message: string): string {
  if (!message) return "";
  if (translatedValues.has(message)) return message;
  if (locale === "zh" && /[\u3400-\u9fff]/.test(message)) return message;
  if (catalog[message]) return translate(locale, message);
  const key = /invalid login credentials/i.test(message)
    ? "邮箱或密码不正确。"
    : /email not confirmed/i.test(message)
      ? "请先验证邮箱，再登录。"
      : /rate limit|too many requests/i.test(message)
        ? "操作过于频繁，请稍后再试。"
        : /库存|stock/i.test(message)
          ? "商品库存已变更，请刷新购物车后重试。"
          : /权限|permission|row.level|请先登录|jwt|session/i.test(message)
            ? "登录已失效或没有操作权限，请重新登录。"
            : /已更新|冲突|version/i.test(message)
              ? "资料已变更，请刷新后重试。"
              : /付款|支付|订阅/i.test(message)
                ? "付款服务暂时无法完成请求，请勿重复付款，请联系商家。"
                : /邮箱|email/i.test(message)
                  ? "请检查邮箱地址及验证状态。"
                  : /订单|凭证|token/i.test(message)
                    ? "订单不存在或访问凭证无效，请联系商家。"
                    : /network|fetch|连接|网络/i.test(message)
                      ? "网络连接失败，请稍后重试。"
                      : "操作未完成，请检查资料后重试或联系管理员。";
  return translate(locale, key);
}
