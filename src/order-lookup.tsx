import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { storeApi as api } from "./customer-store-api";
import { useI18n } from "./i18n";
import { Brand, ErrorBox } from "./ui";
import type { OrderResult } from "./types";

export function OrderLookup() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = "/shop/" + encodeURIComponent(slug);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reference = String(form.get("reference") || "").trim();
    const token = String(form.get("token") || "").trim();
    setBusy(true);
    setError("");
    try {
      const result = await api<OrderResult>("order-result", {
        slug,
        reference,
        token,
      });
      if (result.order.reference !== reference)
        throw new Error("订单不存在或访问凭证无效");
      sessionStorage.setItem("ezshop:order:" + reference, token);
      navigate(base + "/order-result?ref=" + encodeURIComponent(reference));
    } catch {
      // Use the same message for unknown reference, wrong token or wrong store.
      setError("无法查询订单，请核对店铺、订单编号及查询凭证后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="store-shell">
      <Brand to={base} />
      <section className="card result">
        <h1>{t("查询订单")}</h1>
        <p>{t("输入订单编号和下单后保存的专属查询凭证。")}</p>
        <form onSubmit={submit}>
          <label>
            {t("订单编号")}
            <input
              name="reference"
              required
              maxLength={100}
              autoComplete="off"
            />
          </label>
          <label>
            {t("订单查询凭证")}
            <input
              name="token"
              type="password"
              required
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <ErrorBox error={error} />
          <button className="button full" disabled={busy}>
            {busy ? t("正在加载…") : t("查询订单")}
          </button>
        </form>
        <p className="muted">
          {t("查询凭证等同订单密码，请勿公开。遗失后请联系商家核实身份。")}
        </p>
        <Link to={base} className="text-button">
          {t("返回店铺")}
        </Link>
      </section>
    </main>
  );
}

export function OrderAccess({
  reference,
  token,
}: {
  reference: string;
  token: string;
}) {
  const { t } = useI18n();
  const { slug = "" } = useParams();
  if (!token) return null;
  function save() {
    const lookup = new URL(
      import.meta.env.BASE_URL + "shop/" + encodeURIComponent(slug) + "/track",
      window.location.origin,
    ).href;
    const content =
      t("查询订单") +
      ": " +
      lookup +
      "\n" +
      t("订单编号") +
      ": " +
      reference +
      "\n" +
      t("订单查询凭证") +
      ": " +
      token +
      "\n\n" +
      t("查询凭证等同订单密码，请勿公开。遗失后请联系商家核实身份。");
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download =
      "EZShop-" + reference.replace(/[^a-zA-Z0-9_-]/g, "") + ".txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="soft-note">
      <p>{t("保存查询凭证后，可在其他设备查询此订单及发货记录。")}</p>
      <button type="button" className="button secondary" onClick={save}>
        {t("下载订单查询凭证")}
      </button>
      <p className="muted">
        {t("查询凭证等同订单密码，请勿公开。遗失后请联系商家核实身份。")}
      </p>
    </div>
  );
}
