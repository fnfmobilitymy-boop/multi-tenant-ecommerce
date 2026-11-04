import { afterEach, describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_IMAGE_BYTES, uploadImage, validateImage } from "./media";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("商家图片上传", () => {
  it("拒绝空文件、SVG 和超过 5 MB 的文件", () => {
    expect(() =>
      validateImage(new File([], "empty.png", { type: "image/png" })),
    ).toThrow("为空");
    expect(() =>
      validateImage(
        new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
      ),
    ).toThrow("JPG");
    expect(() =>
      validateImage(
        new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.png", {
          type: "image/png",
        }),
      ),
    ).toThrow("5 MB");
  });
  it("上传前拒绝无法解码的图片，不发出上传请求", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockRejectedValue(Error("invalid image")),
    );
    const getUser = vi.fn();
    await expect(
      uploadImage(
        new File(["not an image"], "wrong.png", { type: "image/png" }),
        { auth: { getUser } } as unknown as SupabaseClient,
      ),
    ).rejects.toThrow("无法读取");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("使用已登录用户目录，成功后返回公开图片 URL", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 100, height: 100, close: vi.fn() }),
    );
    const upload = vi.fn().mockResolvedValue({ error: null }),
      getPublicUrl = vi
        .fn()
        .mockReturnValue({
          data: { publicUrl: "https://test.example/storage/logo.png" },
        });
    const from = vi.fn().mockReturnValue({ upload, getPublicUrl });
    const client = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({
            data: { user: { id: "owner-uuid" } },
            error: null,
          }),
      },
      storage: { from },
    } as unknown as SupabaseClient;
    const file = new File(["fixture"], "customer-filename.png", {
      type: "image/png",
    });
    expect(await uploadImage(file, client)).toBe(
      "https://test.example/storage/logo.png",
    );
    expect(from).toHaveBeenCalledWith("ezshop-media");
    expect(upload.mock.calls[0][0]).toMatch(/^owner-uuid\/[a-f0-9-]+\.png$/);
    expect(upload.mock.calls[0][2]).toEqual({
      contentType: "image/png",
      upsert: false,
    });
  });
  it("失败时不返回虚假的成功 URL", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 1, height: 1, close: vi.fn() }),
    );
    const getPublicUrl = vi.fn();
    const client = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: "owner" } }, error: null }),
      },
      storage: {
        from: () => ({
          upload: vi
            .fn()
            .mockResolvedValue({ error: { message: "bucket not found" } }),
          getPublicUrl,
        }),
      },
    } as unknown as SupabaseClient;
    await expect(
      uploadImage(
        new File(["fixture"], "logo.png", { type: "image/png" }),
        client,
      ),
    ).rejects.toThrow("尚未初始化");
    expect(getPublicUrl).not.toHaveBeenCalled();
  });
});
