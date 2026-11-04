/** Build an application-root callback, excluding order/invitation URL tokens. */
export function authRedirectUrl(
  origin: string = window.location.origin,
  base: string = import.meta.env.BASE_URL,
): string {
  const current = new URL(origin);
  const callback = new URL(base || "/", current.origin + "/");
  if (callback.origin !== current.origin || callback.search || callback.hash) {
    throw new Error("验证邮件回跳地址必须是当前网站的应用根目录。");
  }
  callback.pathname = callback.pathname.replace(/\/+$/, "") + "/";
  return callback.toString();
}
