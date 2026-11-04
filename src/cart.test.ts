import { describe, it, expect } from "vitest";
import { parseCart, cartKey } from "./cart";
describe("商家购物车隔离与无效数据处理", () => {
  it("使用不同商家的存储键", () => expect(cartKey("a")).not.toBe(cartKey("b")));
  it("处理损坏及非列表数据", () => {
    expect(parseCart("{")).toEqual([]);
    expect(parseCart("{}")).toEqual([]);
  });
  it("拒绝重复、负数和小数数量", () =>
    expect(
      parseCart(
        JSON.stringify([
          { id: 1, quantity: 2 },
          { id: 1, quantity: 4 },
          { id: 2, quantity: -1 },
          { id: 3, quantity: 1.2 },
          { id: "4", quantity: 1 },
        ]),
      ),
    ).toEqual([{ id: 1, quantity: 2 }]));
});
