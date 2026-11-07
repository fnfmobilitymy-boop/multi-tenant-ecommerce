import { describe, it, expect } from "vitest";
import { salesSeries, csvText } from "./analytics";
import type { Order } from "./types";
const order = (
  created: string,
  total = 100,
  status: Order["status"] = "paid",
) => ({ created, total, status }) as Order;
describe("Order-date sales series", () => {
  it("uses the store calendar at the UTC day boundary", () => {
    const result = salesSeries(
      [order("2026-11-06T16:30:00Z", 3990)],
      7,
      "MYR",
      "en",
      new Date("2026-11-06T17:00:00Z"),
    );
    expect(result.slots.at(-1)).toMatchObject({
      key: "2026-11-07",
      sales: 3990,
      count: 1,
    });
  });
  it("includes only currently paid orders inside the selected period", () => {
    const orders = [
      order("2026-11-07 01:00:00", 200),
      order("2026-11-01T01:00:00Z", 300),
      order("2026-10-31T01:00:00Z", 400),
      order("2026-11-07T01:00:00Z", 900, "pending"),
      order("2026-11-07T01:00:00Z", 900, "refunded"),
      order("invalid"),
    ];
    const result = salesSeries(
      orders,
      7,
      "SGD",
      "en",
      new Date("2026-11-07T04:00:00Z"),
    );
    expect(result.total).toBe(500);
    expect(result.count).toBe(2);
    expect(result.unknown).toBe(1);
    expect(
      salesSeries(orders, 30, "SGD", "en", new Date("2026-11-07T04:00:00Z"))
        .total,
    ).toBe(900);
  });
  it("retains integer VND amounts and zero days without invented data", () => {
    const result = salesSeries(
      [order("2026-11-07T01:00:00Z", 25000)],
      7,
      "VND",
      "vi",
      new Date("2026-11-07T04:00:00Z"),
    );
    expect(result.total).toBe(25000);
    expect(result.slots.filter((s) => s.count === 0)).toHaveLength(6);
    expect(salesSeries([], 30, "KHR", "en").total).toBe(0);
  });
});
describe("Product CSV safety", () => {
  it("neutralizes spreadsheet formulas including whitespace prefixes", () => {
    for (const input of [
      "=1+1",
      " +SUM(A1)",
      "-1+2",
      "@SUM(A1)",
      "\tformula",
      "\rformula",
      "\nformula",
    ])
      expect(csvText([[input]])).toBe("\uFEFF\"'" + input + '"');
  });
  it("escapes commas, quotes and line breaks and preserves non-Latin names", () => {
    expect(
      csvText([
        ['茶,"礼盒"\n新款', 12.5, "MYR"],
        ["ខ្មែរ", null, 0],
      ]),
    ).toBe('\uFEFF"茶,""礼盒""\n新款","12.5","MYR"\r\n"ខ្មែរ","","0"');
  });
});
