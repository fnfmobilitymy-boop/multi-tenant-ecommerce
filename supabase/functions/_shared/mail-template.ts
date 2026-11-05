import { currencyFactor, validCurrency, type Currency } from "./currencies.ts";
const words = {
  zh: {
    receipt: "付款收据",
    reminder: "订单付款提醒",
    shipping: "邮费",
    total: "总额",
    paid: "已核实收款。",
    pending: "订单仍待付款。如已付款，请联系商家核实，请勿重复付款。",
  },
  en: {
    receipt: "Payment receipt",
    reminder: "Payment reminder",
    shipping: "Shipping",
    total: "Total",
    paid: "Payment has been verified.",
    pending:
      "Payment is pending. If you have paid, contact the merchant and do not pay again.",
  },
  ms: {
    receipt: "Resit pembayaran",
    reminder: "Peringatan bayaran",
    shipping: "Kos pos",
    total: "Jumlah",
    paid: "Bayaran telah disahkan.",
    pending:
      "Bayaran masih belum disahkan. Jika sudah bayar, hubungi peniaga dan jangan bayar semula.",
  },
  th: {
    receipt: "ใบเสร็จรับเงิน",
    reminder: "แจ้งเตือนชำระเงิน",
    shipping: "ค่าจัดส่ง",
    total: "ยอดรวม",
    paid: "ยืนยันรับชำระเงินแล้ว",
    pending: "ยังรอชำระเงิน หากชำระแล้วโปรดติดต่อร้านค้า อย่าชำระซ้ำ",
  },
  km: {
    receipt: "បង្កាន់ដៃទូទាត់",
    reminder: "ការរំលឹកទូទាត់",
    shipping: "ថ្លៃដឹក",
    total: "សរុប",
    paid: "បានផ្ទៀងផ្ទាត់ការទូទាត់។",
    pending:
      "ការទូទាត់កំពុងរង់ចាំ។ បើបានទូទាត់រួច សូមទាក់ទងអាជីវករ ហើយកុំទូទាត់ម្ដងទៀត។",
  },
  vi: {
    receipt: "Biên nhận thanh toán",
    reminder: "Nhắc thanh toán",
    shipping: "Phí giao hàng",
    total: "Tổng cộng",
    paid: "Đã xác minh thanh toán.",
    pending:
      "Đơn đang chờ thanh toán. Nếu đã trả tiền, hãy liên hệ nhà bán hàng và không thanh toán lại.",
  },
};
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function notificationMessage(job: {
  kind: string;
  locale?: string;
  currency?: Currency;
  store_name: string;
  reference: string;
  shipping?: number;
  total: number;
  items: { name: string; quantity: number; price: number }[];
}) {
  if (
    !["receipt", "reminder"].includes(job.kind) ||
    !Array.isArray(job.items) ||
    !job.items.length
  )
    throw new Error("Invalid notification");
  const locale =
    job.locale && Object.hasOwn(words, job.locale)
      ? (job.locale as keyof typeof words)
      : "zh";
  const w = words[locale];
  const shipping = job.shipping || 0;
  if (
    !Number.isSafeInteger(job.total) ||
    !Number.isSafeInteger(shipping) ||
    shipping < 0 ||
    job.total < 0 ||
    job.items.some(
      (item) =>
        !Number.isSafeInteger(item.price) ||
        !Number.isSafeInteger(item.quantity) ||
        item.price < 0 ||
        item.quantity < 1,
    )
  )
    throw new Error("Invalid amount");
  const currency = job.currency || "MYR";
  if (!validCurrency(currency)) throw new Error("Invalid currency");
  const money = (amount: number) =>
    currency +
    " " +
    (amount / currencyFactor(currency)).toFixed(currency === "VND" ? 0 : 2);
  const title = job.kind === "receipt" ? w.receipt : w.reminder;
  const message = job.kind === "receipt" ? w.paid : w.pending;
  const lines = job.items.map(
    (item) =>
      item.name +
      " × " +
      item.quantity +
      " · " +
      money(item.price * item.quantity),
  );
  return {
    subject: title + " · " + job.reference,
    text: [
      job.store_name,
      title,
      job.reference,
      ...lines,
      w.shipping + ": " + money(shipping),
      w.total + ": " + money(job.total),
      message,
    ].join("\n"),
    html: `<div lang="${locale}"><h2>${escape(job.store_name)} · ${escape(title)}</h2><p>${escape(job.reference)}</p><ul>${lines.map((line) => "<li>" + escape(line) + "</li>").join("")}</ul><p>${escape(w.shipping)}: ${money(shipping)}</p><p>${escape(w.total)}: ${money(job.total)}</p><p>${escape(message)}</p></div>`,
  };
}
