import { useState } from "react";
import { useI18n } from "./i18n";
import {
  currencyDigits,
  currencyFactor,
  type Currency,
  type CountryCode,
} from "./commerce-currency";
import { MALAYSIA_STATES } from "./delivery";
export interface ShippingRule {
  state: string;
  city: string;
  postcode_prefix: string;
  fee: number;
}
export function ShippingZones({
  rules,
  currency,
  country,
}: {
  rules: ShippingRule[];
  currency: Currency;
  country: CountryCode;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState(() =>
    rules.map((r) => ({ ...r, fee: String(r.fee / currencyFactor(currency)) })),
  );
  const update = (index: number, key: string, value: string) =>
    setRows((old) =>
      old.map((r, i) => (i === index ? { ...r, [key]: value } : r)),
    );
  return (
    <section aria-label={t("分区固定邮费")}>
      <h3>{t("分区固定邮费")}</h3>
      <p className="muted">
        {t(
          "可按州属、城市或邮编前缀设置。填0免邮；留空适用全部。邮编优先，其次城市、州属，未匹配使用默认邮费。",
        )}
      </p>
      <input type="hidden" name="shipping_rules" value={JSON.stringify(rows)} />
      {rows.map((r, i) => (
        <fieldset
          key={i}
          style={{
            marginBottom: 16,
            padding: 16,
            border: "1px solid #ddd",
            borderRadius: 10,
          }}
        >
          <legend>
            {t("运费规则")} {i + 1}
          </legend>
          <label>
            {t("适用州属")}
            {country === "MY" ? (
              <select
                aria-label={t("适用州属")}
                value={r.state}
                onChange={(e) => update(i, "state", e.target.value)}
              >
                <option value="">{t("全部州属")}</option>
                {MALAYSIA_STATES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            ) : (
              <input
                aria-label={t("适用州属")}
                maxLength={100}
                value={r.state}
                onChange={(e) => update(i, "state", e.target.value)}
              />
            )}
          </label>
          <label>
            {t("适用城市／地区")}
            <input
              maxLength={100}
              value={r.city}
              onChange={(e) => update(i, "city", e.target.value)}
            />
          </label>
          <label>
            {t("邮编前缀（选填）")}
            <input
              inputMode="numeric"
              pattern="[0-9]{1,6}"
              maxLength={6}
              value={r.postcode_prefix}
              onChange={(e) => update(i, "postcode_prefix", e.target.value)}
            />
          </label>
          <label>
            {t("固定邮费（{currency}）", { currency })}
            <input
              type="number"
              min="0"
              max={1000000 / currencyFactor(currency)}
              step={currencyDigits(currency) === 0 ? "1" : "0.01"}
              required
              value={r.fee}
              onChange={(e) => update(i, "fee", e.target.value)}
            />
          </label>
          <button
            type="button"
            className="text-button danger"
            onClick={() => setRows((old) => old.filter((_, n) => n !== i))}
          >
            {t("删除运费规则")}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="button secondary"
        disabled={rows.length >= 50}
        onClick={() =>
          setRows((old) => [
            ...old,
            { state: "", city: "", postcode_prefix: "", fee: "0" },
          ])
        }
      >
        {t("添加运费规则")}
      </button>
    </section>
  );
}
