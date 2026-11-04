import { describe, it, expect } from "vitest";
import {
  allowedLanguages,
  normalizeLocale,
  translate,
  translateError,
  LANGUAGES,
  intlLocale,
} from "./i18n-core";
import messages from "./locales/messages.json";
describe("多语言范围与翻译", () => {
  it("顾客及商家各支持六语；平台只提供中英", () => {
    expect(allowedLanguages("customer").map((l) => l.code)).toEqual([
      "zh",
      "en",
      "ms",
      "th",
      "km",
      "vi",
    ]);
    expect(allowedLanguages("merchant")).toHaveLength(6);
    expect(allowedLanguages("platform").map((l) => l.code)).toEqual([
      "zh",
      "en",
    ]);
    expect(normalizeLocale("th", "platform")).toBe("zh");
    expect(normalizeLocale("vi", "merchant")).toBe("vi");
    expect(normalizeLocale("<script>", "customer")).toBe("zh");
  });
  it("全部文案均含五种非中文译文并保留占位参数", () => {
    for (const [key, values] of Object.entries(messages)) {
      expect(values, key).toHaveLength(5);
      for (const value of values) {
        expect(value.trim(), key).not.toBe("");
        expect(value.match(/\{\w+\}/g) || [], key).toEqual(
          key.match(/\{\w+\}/g) || [],
        );
      }
    }
  });
  it("翻译系统文案及数量，但不更改未知商家内容", () => {
    for (const { code } of LANGUAGES) {
      expect(translate(code, "{count} 笔订单等待付款", { count: 3 })).toContain(
        "3",
      );
      expect(translate(code, "Kedai Kenny")).toBe("Kedai Kenny");
      expect(intlLocale(code)).toBeTruthy();
    }
    expect(translate("en", "加入购物车")).toBe("Add to cart");
    expect(translate("ms", "加入购物车")).toBe("Tambah ke troli");
    expect(translate("th", "加入购物车")).toBe("เพิ่มลงตะกร้า");
    expect(translate("km", "加入购物车")).toBe("បន្ថែមក្នុងកន្ត្រក");
    expect(translate("vi", "加入购物车")).toBe("Thêm vào giỏ hàng");
  });
  it("校验错误随界面语言翻译；未知后台信息用安全可理解的提示", () => {
    expect(translateError("en", "Invalid login credentials")).toBe(
      "Incorrect email or password.",
    );
    expect(translateError("vi", "商品库存不足")).toContain("Tồn kho");
    expect(translateError("km", "未知内部异常")).toBe(
      translate("km", "操作未完成，请检查资料后重试或联系管理员。"),
    );
    expect(
      translateError("en", translate("en", "两次输入的密码不一致。")),
    ).toBe("Passwords do not match.");
    expect(
      translateError("zh", "图片存储尚未初始化，请先完成图片上传配置。"),
    ).toContain("图片存储");
  });
});
