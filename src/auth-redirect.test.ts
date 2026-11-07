import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authRedirectUrl } from "./auth-redirect";
import { supabaseApi } from "./supabase-api";
const origin = "https://fnfmobilitymy-boop.github.io";
const callback = origin + "/multi-tenant-ecommerce/merchant";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("验证邮件回跳", () => {
  it("保留 GitHub Pages 项目路径", () =>
    expect(authRedirectUrl(origin, "/multi-tenant-ecommerce/")).toBe(callback));
  it("支持独立域名和本地开发", () => {
    expect(authRedirectUrl("https://shop.example", "/")).toBe(
      "https://shop.example/merchant",
    );
    expect(authRedirectUrl("http://localhost:5173", "/")).toBe(
      "http://localhost:5173/merchant",
    );
  });
  it("平台密码恢复使用固定的平台路径，兼容项目和根域名", () => {
    expect(authRedirectUrl("https://ezshop.lifestyle", "/", "platform")).toBe(
      "https://ezshop.lifestyle/platform/reset-password",
    );
    expect(
      authRedirectUrl(origin, "/multi-tenant-ecommerce/", "platform"),
    ).toBe(origin + "/multi-tenant-ecommerce/platform/reset-password");
  });
  it("拒绝外站和带查询凭证的回跳", () => {
    expect(() => authRedirectUrl(origin, "https://other.example")).toThrow();
    expect(() => authRedirectUrl(origin, "/?token=private")).toThrow();
  });
  it("注册、团队注册和重发均提交正确的回跳，不发送真实邮件", async () => {
    vi.stubGlobal("window", { location: { origin } });
    vi.stubEnv("BASE_URL", "/multi-tenant-ecommerce/");
    const signUp = vi
      .fn()
      .mockResolvedValue({ data: { session: {} }, error: null });
    const resend = vi.fn().mockResolvedValue({ error: null });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: { signUp, resend },
      rpc,
    } as unknown as SupabaseClient;
    await supabaseApi(client, "register", {
      name: "Store",
      slug: "store",
      email: "test@example.test",
      password: "Test-only-12345",
    });
    await supabaseApi(client, "join", {
      email: "agent@example.test",
      password: "Test-only-12345",
      token: "private-invitation",
    });
    await supabaseApi(client, "resend-confirmation", {
      email: "test@example.test",
    });
    expect(signUp.mock.calls[0][0].options.emailRedirectTo).toBe(callback);
    expect(signUp.mock.calls[1][0].options.emailRedirectTo).toBe(callback);
    expect(resend.mock.calls[0][0]).toEqual({
      type: "signup",
      email: "test@example.test",
      options: { emailRedirectTo: callback },
    });
  });
});
