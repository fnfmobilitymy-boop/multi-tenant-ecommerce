import {
  currencyTimeZone,
  type Currency,
} from "../supabase/functions/_shared/currencies";
import type { Order } from "./types";
export function salesSeries(
  orders: Order[],
  days: number,
  currency: Currency,
  locale: string,
  now = new Date(),
) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: currencyTimeZone(currency),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const key = (date: Date) => {
    const p = formatter.formatToParts(date);
    return ["year", "month", "day"]
      .map((type) => p.find((x) => x.type === type)?.value)
      .join("-");
  };
  const today = key(now);
  const slots = Array.from({ length: days }, (_, i) => {
    const date = new Date(today + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() - (days - 1 - i));
    return {
      key: date.toISOString().slice(0, 10),
      label: new Intl.DateTimeFormat(
        locale,
        days === 7
          ? { weekday: "short", timeZone: "UTC" }
          : { day: "numeric", timeZone: "UTC" },
      ).format(date),
      sales: 0,
      count: 0,
    };
  });
  let unknown = 0;
  for (const order of orders) {
    if (order.status !== "paid") continue;
    const raw = order.created.includes("T")
      ? order.created
      : order.created.replace(" ", "T") + "Z";
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) {
      unknown++;
      continue;
    }
    const slot = slots.find((s) => s.key === key(date));
    if (slot) {
      slot.sales += order.total;
      slot.count++;
    }
  }
  return {
    slots,
    total: slots.reduce((n, s) => n + s.sales, 0),
    count: slots.reduce((n, s) => n + s.count, 0),
    unknown,
  };
}
export function csvText(rows: unknown[][]) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value ?? "");
            if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
              text = "'" + text;
            return '"' + text.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
