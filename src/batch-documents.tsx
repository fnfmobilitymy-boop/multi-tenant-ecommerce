import { useCommerceDate, countryNames } from "./commerce-currency";
import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useI18n } from "./i18n";
import { ErrorBox, Modal } from "./ui";
import type { Merchant, Order, OrderResult } from "./types";
import { localizedItem } from "./content";
export function BatchDocuments({
  orders,
  merchant,
}: {
  orders: Order[];
  merchant: Merchant;
}) {
  const { t, locale } = useI18n();
  const dateLabel = useCommerceDate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [documents, setDocuments] = useState<OrderResult[] | null>(null),
    [kind, setKind] = useState<"packing" | "address">("packing");
  async function prepare(mode: "packing" | "address") {
    setBusy(true);
    setError("");
    setDocuments(null);
    setKind(mode);
    try {
      if (!orders.length || orders.length > 50)
        throw new Error("每批请选择1至50个已付款且待发货的订单。");
      const next: OrderResult[] = [];
      for (const order of orders) {
        const result = await api<OrderResult>("orders/detail?id=" + order.id);
        if (
          result.order.id !== order.id ||
          result.order.status !== "paid" ||
          result.order.fulfillment_status === "shipped"
        )
          throw new Error("订单状态已变化，请刷新后重新选择。");
        next.push(result);
      }
      setDocuments(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = kind === "packing" ? t("配货单") : t("收货地址标签");
  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <span>
          {t("已选订单")}：{orders.length} / 50
        </span>
        <button
          className="button secondary"
          disabled={busy || !orders.length}
          onClick={() => void prepare("packing")}
        >
          {t("批量打印配货单")}
        </button>
        <button
          className="button secondary"
          disabled={busy || !orders.length}
          onClick={() => void prepare("address")}
        >
          {t("批量打印地址标签")}
        </button>
      </div>
      <p className="muted">
        {t("打印不会确认收款或标记已发货。地址标签不是快递公司官方面单。")}
      </p>
      <ErrorBox error={error} />
      {documents &&
        createPortal(
          <div className="batch-print-root">
            <Modal title={title} close={() => setDocuments(null)}>
              <p className="batch-no-print">
                {t(
                  "打印不会确认收款或标记已发货。地址标签不是快递公司官方面单。",
                )}
              </p>
              <button
                className="button batch-no-print"
                onClick={() => window.print()}
              >
                {t("打印")}
              </button>
              {documents.map((d) => (
                <article className="packing-document" key={d.order.id}>
                  <h2>
                    {merchant.name} · {title}
                  </h2>
                  <strong>{d.order.reference}</strong>
                  <p>{dateLabel(d.order.created, locale)}</p>
                  <h3>{t("收件人")}</h3>
                  <p>
                    {d.order.customer} · {d.order.phone}
                  </p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{d.order.address}</p>
                  <p>
                    {[d.order.city, d.order.state, d.order.postcode]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p>
                    {t(
                      countryNames[
                        d.order.country_code || merchant.country_code || "MY"
                      ],
                    )}
                  </p>
                  {kind === "packing" && (
                    <>
                      <h3>{t("商品")}</h3>
                      <ul>
                        {d.items.map((item, i) => (
                          <li key={i}>
                            {localizedItem(item, locale).name} × {item.quantity}
                          </li>
                        ))}
                      </ul>
                      {d.order.note && (
                        <p>
                          {t("备注")}：{d.order.note}
                        </p>
                      )}
                    </>
                  )}
                </article>
              ))}
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}
