import type { SupabaseClient } from "@supabase/supabase-js";
import { authRedirectUrl } from "./auth-redirect";
export async function supabaseApi<T>(
  client: SupabaseClient,
  path: string,
  data?: unknown,
): Promise<T> {
  if (path === "content-translate") {
    const { data: result, error } = await client.functions.invoke(
      "translate-content",
      { body: data as Record<string, unknown> },
    );
    if (error)
      throw new Error("自动翻译服务尚未配置或暂时不可用，请手动填写译文。");
    return result as T;
  }
  const url = new URL(path, "https://ezshop.local/");
  let route = url.pathname.slice(1);
  let payload: Record<string, unknown> = {
    ...Object.fromEntries(url.searchParams),
    ...((data as Record<string, unknown>) || {}),
  };
  if (route === "join") {
    const { data: auth, error } = await client.auth.signUp({
      email: String(payload.email),
      password: String(payload.password),
      options: {
        emailRedirectTo: authRedirectUrl(),
        data: { invite_token: payload.token },
      },
    });
    if (error) throw error;
    if (!auth.session)
      throw new Error(
        "请先验证邮箱，再使用此邮箱和密码登录；系统会接受有效邀请。",
      );
    const { error: joinError } = await client.rpc("ezshop_api", {
      route: "join",
      payload: { token: payload.token },
    });
    if (joinError) throw joinError;
    return { ok: true } as T;
  }
  if (route === "register") {
    const { data: auth, error } = await client.auth.signUp({
      email: String(payload.email),
      password: String(payload.password),
      options: {
        emailRedirectTo: authRedirectUrl(),
        data: { name: payload.name, slug: payload.slug },
      },
    });
    if (error) throw error;
    if (!auth.session)
      throw new Error("账号已创建，请先通过邮件验证，再返回登录。");
    return { ok: true } as T;
  }
  if (route === "resend-confirmation") {
    const { error } = await client.auth.resend({
      type: "signup",
      email: String(payload.email),
      options: { emailRedirectTo: authRedirectUrl() },
    });
    if (error) throw error;
    return { ok: true } as T;
  }
  if (route === "recover-password") {
    const { error } = await client.auth.resetPasswordForEmail(
      String(payload.email),
      { redirectTo: authRedirectUrl() },
    );
    if (error) throw error;
    return { ok: true } as T;
  }
  if (route === "update-password") {
    if (
      typeof payload.password !== "string" ||
      payload.password.length < 10 ||
      payload.password.length > 256
    )
      throw new Error("新密码需要 10 到 256 个字符。");
    const { data: current, error: sessionError } = await client.auth.getUser();
    if (sessionError || !current.user)
      throw new Error("重设链接已失效，请重新申请。");
    const { error } = await client.auth.updateUser({
      password: payload.password,
    });
    if (error) throw error;
    const { error: signOutError } = await client.auth.signOut({
      scope: "global",
    });
    return { ok: true, sign_out_pending: !!signOutError } as T;
  }
  if (route === "login") {
    const { error } = await client.auth.signInWithPassword({
      email: String(payload.email),
      password: String(payload.password),
    });
    if (error) throw error;
    const { data: current } = await client.auth.getUser();
    if (current.user?.user_metadata?.invite_token) {
      const { error: joinError } = await client.rpc("ezshop_api", {
        route: "join",
        payload: { token: current.user.user_metadata.invite_token },
      });
      if (joinError) throw joinError;
    }
    return { ok: true } as T;
  }
  if (route === "logout") {
    const { error } = await client.auth.signOut();
    if (error) throw error;
    return { ok: true } as T;
  }
  const { data: body, error } = await client.rpc("ezshop_api", {
    route,
    payload,
  });
  if (error) throw new Error(error.message);
  return body as T;
}
