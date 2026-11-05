import { createContext, useContext, type ReactNode } from "react";
import { money, dateLabel } from "./api";
import { useI18n } from "./i18n";
import {
  countryCurrencies,
  currencyFactor,
  currencyDigits,
  suggestCountry,
  type Currency,
  type CountryCode,
} from "../supabase/functions/_shared/currencies";
export { countryCurrencies, currencyFactor, currencyDigits, suggestCountry };
export type { Currency, CountryCode };
const Context = createContext<Currency>("MYR");
export function CommerceCurrency({
  currency = "MYR",
  children,
}: {
  currency?: Currency;
  children: ReactNode;
}) {
  return <Context.Provider value={currency}>{children}</Context.Provider>;
}
export function useCommerceCurrency() {
  return useContext(Context);
}
export function useCommerceMoney() {
  const currency = useCommerceCurrency();
  return (amount: number, locale: Parameters<typeof money>[1]) =>
    money(amount, locale, currency);
}
export const countryNames: Record<CountryCode, string> = {
  MY: "马来西亚",
  SG: "新加坡",
  TH: "泰国",
  KH: "柬埔寨",
  VN: "越南",
};
export function initialRegion() {
  const country = suggestCountry(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    typeof navigator === "undefined" ? [] : navigator.languages,
  );
  return { country, currency: countryCurrencies[country][0] as Currency };
}
export function RegionFields({
  value,
  onChange,
  disabled = false,
}: {
  value: { country: CountryCode; currency: Currency };
  onChange: (value: { country: CountryCode; currency: Currency }) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <label>
        {t("商家国家／地区")}
        <select
          aria-label={t("商家国家／地区")}
          name="country_code"
          required
          disabled={disabled}
          value={value.country}
          onChange={(e) => {
            const country = e.target.value as CountryCode;
            onChange({ country, currency: countryCurrencies[country][0] });
          }}
        >
          {Object.keys(countryCurrencies).map((c) => (
            <option key={c} value={c}>
              {t(countryNames[c as CountryCode])}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("店铺币种")}
        <select
          aria-label={t("店铺币种")}
          name="currency"
          required
          disabled={disabled}
          value={value.currency}
          onChange={(e) =>
            onChange({ ...value, currency: e.target.value as Currency })
          }
        >
          {countryCurrencies[value.country].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <small>
          {t(
            "设备地区仅作建议，请确认商家所在国家；语言切换不会改变交易币种。",
          )}
        </small>
      </label>
      {disabled && (
        <p className="soft-note">
          {t("店铺已有商品或交易，国家及币种已锁定，不能直接转换历史金额。")}
        </p>
      )}
    </>
  );
}

export function useCommerceDate() {
  const currency = useCommerceCurrency();
  return (date: string, locale: Parameters<typeof dateLabel>[1]) =>
    dateLabel(date, locale, currency);
}
