import { useMemo, useState } from "react";
import { ArrowUpRight, BarChart3 } from "lucide-react";
import { useI18n, intlLocale } from "./i18n";
import { useCommerceMoney, useCommerceCurrency } from "./commerce-currency";
import { salesSeries } from "./analytics";
import type { Order } from "./types";
export function SalesAnalytics({ orders }: { orders: Order[] }) {
  const { t, locale } = useI18n(),
    money = useCommerceMoney(),
    currency = useCommerceCurrency();
  const [days, setDays] = useState(7);
  const chart = useMemo(
    () => salesSeries(orders, days, currency, intlLocale(locale)),
    [orders, days, currency, locale],
  );
  const max = Math.max(1, ...chart.slots.map((s) => s.sales));
  const paid = orders.filter((o) => o.status === "paid").length,
    pending = orders.filter((o) => o.status === "pending").length,
    other = orders.length - paid - pending,
    total = Math.max(1, orders.length),
    a = (paid / total) * 100,
    b = ((paid + pending) / total) * 100;
  return (
    <div className="analytics-grid">
      <section className="card analytics-card">
        <div className="analytics-heading">
          <div>
            <h2>{t("销售趋势")}</h2>
            <p>{t("按下单日期统计当前已付款订单")}</p>
          </div>
          <select
            aria-label={t("统计周期")}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>{t("最近7天")}</option>
            <option value={30}>{t("最近30天")}</option>
          </select>
        </div>
        <div className="chart-summary">
          <strong>{money(chart.total, locale)}</strong>
          <span>
            <ArrowUpRight size={15} />
            {chart.count} {t("笔已付款订单")}
          </span>
        </div>
        <div className="sales-chart" role="group" aria-label={t("销售趋势")}>
          <div className="chart-grid-lines">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="chart-bars">
            {chart.slots.map((s, i) => (
              <div className="chart-column" key={s.key}>
                <div
                  className="chart-bar"
                  style={{
                    height: `${(s.sales / max) * 100}%`,
                    minHeight: s.sales ? 5 : 0,
                  }}
                  tabIndex={0}
                  aria-label={`${s.key}: ${money(s.sales, locale)}, ${s.count}`}
                >
                  <span className="chart-tooltip">
                    {s.key}
                    <strong>{money(s.sales, locale)}</strong>
                  </span>
                </div>
                {(days === 7 || i % 5 === 0 || i === days - 1) && (
                  <small>{s.label}</small>
                )}
              </div>
            ))}
          </div>
        </div>
        <details className="chart-data">
          <summary>{t("查看数据")}</summary>
          <table>
            <thead>
              <tr>
                <th>{t("日期")}</th>
                <th>{t("已确认销售额")}</th>
                <th>{t("订单数")}</th>
              </tr>
            </thead>
            <tbody>
              {chart.slots.map((s) => (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <td>{money(s.sales, locale)}</td>
                  <td>{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {chart.total === 0 && (
          <p className="chart-empty">
            <BarChart3 size={16} />
            {t("此期间暂无已付款订单")}
          </p>
        )}
        {chart.unknown > 0 && (
          <p className="muted">
            {t("日期不明的订单未计入趋势")}：{chart.unknown}
          </p>
        )}
      </section>
      <section className="card analytics-card order-distribution">
        <div className="analytics-heading">
          <div>
            <h2>{t("订单状态分布")}</h2>
            <p>{t("全部真实订单")}</p>
          </div>
        </div>
        <div
          className="order-donut"
          style={{
            background: orders.length
              ? `conic-gradient(#7854e7 0% ${a}%, #f4be64 ${a}% ${b}%, #dfe3ed ${b}% 100%)`
              : "#eef0f6",
          }}
        >
          <div>
            <strong>{orders.length}</strong>
            <span>{t("订单总数")}</span>
          </div>
        </div>
        <div className="distribution-legend">
          {[
            [t("已付款"), paid, "#7854e7"],
            [t("待付款"), pending, "#f4be64"],
            [t("取消或退款"), other, "#dfe3ed"],
          ].map(([name, n, color]) => (
            <div key={name}>
              <span>
                <i style={{ background: String(color) }} />
                {name}
              </span>
              <strong>{n}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
