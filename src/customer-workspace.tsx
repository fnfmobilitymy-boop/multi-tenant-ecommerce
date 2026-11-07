import { useMemo, useState } from "react";
import { Search, Users } from "lucide-react";
import { useI18n } from "./i18n";
import { useCommerceMoney, useCommerceDate } from "./commerce-currency";
import type { Order } from "./types";
export function CustomerWorkspace({
  orders,
  open,
}: {
  orders: Order[];
  open: (id: number) => void;
}) {
  const { t, locale } = useI18n(),
    money = useCommerceMoney(),
    date = useCommerceDate();
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState("");
  const customers = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        name: string;
        email: string;
        phone: string;
        orders: Order[];
        paid: number;
        last: string;
      }
    >();
    for (const o of orders) {
      const key = (o.email || o.phone || o.customer).trim().toLowerCase();
      const c = map.get(key) || {
        key,
        name: o.customer,
        email: o.email,
        phone: o.phone,
        orders: [],
        paid: 0,
        last: o.created,
      };
      c.orders.push(o);
      if (o.status === "paid") c.paid += o.total;
      if (o.created > c.last) {
        c.last = o.created;
        c.name = o.customer;
        c.phone = o.phone;
      }
      map.set(key, c);
    }
    return [...map.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [orders]);
  const rows = customers.filter((c) =>
    `${c.name} ${c.email} ${c.phone}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const detail = customers.find((c) => c.key === selected);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("订单联系资料")}</span>
          <h1>{t("顾客管理")}</h1>
          <p>
            {t("根据店铺订单整理顾客资料与已付款消费，不代表已验证会员身份。")}
          </p>
        </div>
        <Users className="purple" size={26} />
      </div>
      <div className="catalog-stats">
        {[
          [t("顾客数"), customers.length, "lavender"],
          [
            t("回购顾客"),
            customers.filter(
              (c) => c.orders.filter((o) => o.status === "paid").length > 1,
            ).length,
            "mint",
          ],
          [
            t("已付款订单"),
            orders.filter((o) => o.status === "paid").length,
            "sky",
          ],
          [
            t("待付款"),
            orders.filter((o) => o.status === "pending").length,
            "peach",
          ],
        ].map(([label, n, color]) => (
          <article className={"catalog-stat " + color} key={label}>
            <span>{label}</span>
            <strong>{n}</strong>
          </article>
        ))}
      </div>
      <section className="card">
        <div className="catalog-toolbar">
          <div className="search">
            <Search size={18} />
            <input
              aria-label={t("搜索顾客")}
              placeholder={t("搜索姓名、邮箱或电话")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["顾客", "订单数", "已确认销售额", "最近下单", "操作"].map(
                  (k) => (
                    <th key={k}>{t(k)}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.key}>
                  <td>
                    <div className="catalog-name">
                      <div className="avatar">{c.name.slice(0, 1)}</div>
                      <div>
                        <strong>{c.name}</strong>
                        <small>
                          {c.email}
                          <br />
                          {c.phone}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>{c.orders.length}</td>
                  <td>{money(c.paid, locale)}</td>
                  <td>{date(c.last, locale)}</td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => setSelected(c.key)}
                    >
                      {t("查看订单")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">{t("暂无匹配顾客")}</div>}
        </div>
      </section>
      {detail && (
        <section className="card customer-order-panel">
          <div className="card-heading">
            <h2>
              {detail.name} · {t("订单")}
            </h2>
            <button className="text-button" onClick={() => setSelected("")}>
              {t("关闭")}
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <tbody>
                {detail.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.reference}</td>
                    <td>{money(o.total, locale)}</td>
                    <td>{date(o.created, locale)}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => open(o.id)}
                      >
                        {t("查看详情")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
