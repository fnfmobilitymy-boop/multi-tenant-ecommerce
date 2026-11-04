import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseApi } from "./supabase-api";
import { isPasswordRecovery } from "./auth-redirect";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("账号找回", () => {
  it("只识别 recovery 标记，不把其他验证邮件当成密码重设", () => {
    expect(
      isPasswordRecovery(
        "https://shop.example/#type=recovery&access_token=fixture",
      ),
    ).toBe(true);
    expect(
      isPasswordRecovery(
        "https://shop.example/#type=signup&access_token=fixture",
      ),
    ).toBe(false);
  });
  it("重设邮件使用实际应用根路径，测试不发送邮件", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://fnfmobilitymy-boop.github.io" },
    });
    vi.stubEnv("BASE_URL", "/multi-tenant-ecommerce/");
    const send = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: { resetPasswordForEmail: send },
    } as unknown as SupabaseClient;
    await supabaseApi(client, "recover-password", {
      email: "test@example.test",
    });
    expect(send).toHaveBeenCalledWith("test@example.test", {
      redirectTo:
        "https://fnfmobilitymy-boop.github.io/multi-tenant-ecommerce/",
    });
  });
  it("没有有效用户时不能更新密码", async () => {
    const updateUser = vi.fn();
    const client = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: null }, error: null }),
        updateUser,
      },
    } as unknown as SupabaseClient;
    await expect(
      supabaseApi(client, "update-password", {
        password: "New-test-only-12345",
      }),
    ).rejects.toThrow("链接已失效");
    expect(updateUser).not.toHaveBeenCalled();
  });
  it("只有密码真实更新成功后才显示成功，并撤销会话", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null }),
      signOut = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({
            data: { user: { id: "fixture" } },
            error: null,
          }),
        updateUser,
        signOut,
      },
    } as unknown as SupabaseClient;
    expect(
      await supabaseApi(client, "update-password", {
        password: "New-test-only-12345",
      }),
    ).toEqual({ ok: true, sign_out_pending: false });
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
    updateUser.mockResolvedValue({ error: Error("password rejected") });
    signOut.mockClear();
    await expect(
      supabaseApi(client, "update-password", {
        password: "New-test-only-12345",
      }),
    ).rejects.toThrow();
    expect(signOut).not.toHaveBeenCalled();
  });
  it("退出失败不能冒称密码更新失败", async () => {
    const client = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({
            data: { user: { id: "fixture" } },
            error: null,
          }),
        updateUser: vi.fn().mockResolvedValue({ error: null }),
        signOut: vi.fn().mockResolvedValue({ error: Error("network") }),
      },
    } as unknown as SupabaseClient;
    expect(
      await supabaseApi(client, "update-password", {
        password: "New-test-only-12345",
      }),
    ).toEqual({ ok: true, sign_out_pending: true });
  });
});
