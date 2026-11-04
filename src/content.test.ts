import { it, expect } from "vitest";
import { localizedContent, localizedItem, contentField } from "./content";
import { browserLocale } from "./i18n-core";
import {
  translationInput,
  translatedFields,
  decodeTranslation,
} from "../supabase/functions/_shared/content-translation";
it("商品内容随语言变化但价格、库存、分类标识及原始数据不变", () => {
  const raw = {
    name: "原文",
    description: "原介绍",
    price: 3900,
    stock: 3,
    category: "服装",
    content_translations: {
      en: { name: "Shirt", description: "A shirt", category: "Clothing" },
    },
  };
  const view = localizedContent(raw, "en");
  expect(view.name).toBe("Shirt");
  expect(view.price).toBe(3900);
  expect(view.stock).toBe(3);
  expect(view.category).toBe("服装");
  expect(contentField(view, "category", "en")).toBe("Clothing");
  expect(raw.name).toBe("原文");
  expect(localizedContent(raw, "th").name).toBe("原文");
});
it("订单显示成交时的语言快照，缺少译文时保留原记录", () => {
  const item = {
    name: "原商品 · 原规格",
    content_translations: { vi: { name: "Áo", variant: "Đen / M" } },
  };
  expect(localizedItem(item, "vi").name).toBe("Áo · Đen / M");
  expect(localizedItem(item, "en").name).toBe(item.name);
});
it("商家/顾客首次语言参考浏览器，平台仍限制中英", () => {
  expect(browserLocale(["th-TH", "en-US"], "merchant")).toBe("th");
  expect(browserLocale(["km-KH"], "customer")).toBe("km");
  expect(browserLocale(["vi-VN"], "merchant")).toBe("vi");
  expect(browserLocale(["fr-FR"],"customer")).toBe("en");
  expect(browserLocale(["th-TH", "en-US"], "platform")).toBe("en");
});
it("外部翻译仅接受公开内容字段，不允许顾客信息或金额进入翻译", () => {
  expect(
    translationInput({
      kind: "product",
      fields: { name: "Shirt", description: "Hello" },
    }).characters,
  ).toBe(10);
  expect(() =>
    translationInput({
      kind: "product",
      fields: { name: "Shirt", customer: "Private name" },
    }),
  ).toThrow();
  expect(() =>
    translationInput({
      kind: "store",
      fields: { name: "Store", phone: "0123" },
    }),
  ).toThrow();
  expect(() =>
    translationInput({
      kind: "product",
      fields: { name: "Shirt", price: "1" },
    }),
  ).toThrow();
});
it("服务返回必须完整且符合字段长度；实体解码只生成纯文字", () => {
  expect(decodeTranslation("A &amp; B &#x1F455;")).toBe("A & B 👕");
  expect(
    translatedFields(
      { data: { translations: [{ translatedText: "A &amp; B" }] } },
      [["name", "原名"]],
      "product",
    ),
  ).toEqual({ name: "A & B" });
  expect(() =>
    translatedFields(
      { data: { translations: [] } },
      [["name", "X"]],
      "product",
    ),
  ).toThrow();
  expect(() =>
    translatedFields(
      { data: { translations: [{ translatedText: "x".repeat(121) }] } },
      [["name", "X"]],
      "product",
    ),
  ).toThrow();
});
