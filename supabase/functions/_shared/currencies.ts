export const countryCurrencies = {
  MY: ["MYR"],
  SG: ["SGD"],
  TH: ["THB"],
  KH: ["KHR", "USD"],
  VN: ["VND"],
} as const;
export type CountryCode = keyof typeof countryCurrencies;
export type Currency = "MYR" | "SGD" | "THB" | "KHR" | "USD" | "VND";
export const currencyDigits = (currency: Currency) =>
  currency === "VND" ? 0 : 2;
export const currencyFactor = (currency: Currency) =>
  10 ** currencyDigits(currency);
export function validCurrency(value: unknown): value is Currency {
  return ["MYR", "SGD", "THB", "KHR", "USD", "VND"].includes(String(value));
}
export function toMinor(value: unknown, currency: Currency): number {
  const text = String(value).trim(),
    digits = currencyDigits(currency);
  if (
    !validCurrency(currency) ||
    !(digits === 0 ? /^\d+$/ : /^\d+(\.\d{1,2})?$/).test(text)
  )
    throw new Error("金额精度与币种不一致");
  const [whole, fraction = ""] = text.split(".");
  const amount =
    Number(whole) * currencyFactor(currency) +
    Number(fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(amount)) throw new Error("金额超出范围");
  return amount;
}
export function suggestCountry(
  timeZone: string,
  languages: readonly string[],
): CountryCode {
  const zones: Record<string, CountryCode> = {
    "Asia/Kuala_Lumpur": "MY",
    "Asia/Kuching": "MY",
    "Asia/Singapore": "SG",
    "Asia/Bangkok": "TH",
    "Asia/Phnom_Penh": "KH",
    "Asia/Ho_Chi_Minh": "VN",
    "Asia/Saigon": "VN",
  };
  if (zones[timeZone]) return zones[timeZone];
  for (const language of languages) {
    const country = language.toUpperCase().split(/[-_]/).at(-1);
    if (country && country in countryCurrencies) return country as CountryCode;
  }
  return "MY";
}

export function currencyTimeZone(currency: Currency): string {
  return {
    MYR: "Asia/Kuala_Lumpur",
    SGD: "Asia/Singapore",
    THB: "Asia/Bangkok",
    KHR: "Asia/Phnom_Penh",
    USD: "Asia/Phnom_Penh",
    VND: "Asia/Ho_Chi_Minh",
  }[currency];
}
