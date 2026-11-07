import { storeApi } from "./customer-store-api";
import { MerchantReceiving } from "./merchant-receiving";
import { stripeAutomationEnabled, stripeConnectEnabled } from "./features";
import { intlLocale, useI18n } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { CreditCard, Wallet } from "lucide-react";
import { supabase } from "./api";
import { ErrorBox } from "./ui";
import { stripeRedirect } from "../supabase/functions/_shared/payment-security";
export function MerchantPayments({
  plan = "",
  trialEndsAt,
  showManualSettings = true,
}: {
  plan?: string;
  trialEndsAt?: string;
  showManualSettings?: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t("收款与订阅")}</h1>
          <p>{t("商品款付给商家，平台服务费付给 EZShop。")}</p>
        </div>
        <Wallet className="purple" size={25} />
      </div>
      {showManualSettings && <MerchantReceiving />}
      <div className="overview-grid">
        <section className="card payment-panel">
          <h2>{t("商品订单收款")}</h2>
          <span className="badge pending">{t("人工核实收款")}</span>
          <p>
            {t("顾客下单后，请与顾客安排付款，并在核实实际到账后确认收款。")}
          </p>
          <small>
            {t("提交订单不会自动扣款，商家确认到账前订单保持待付款。")}
          </small>
        </section>
        <section className="card payment-panel">
          <h2>{t("EZShop 套餐与账单")}</h2>
          <p>{t("Pro：MYR 99.90/月，另加6%税费，共MYR 105.89/月。")}</p>
          {trialEndsAt && new Date(trialEndsAt).getTime() > Date.now() && (
            <p>
              {t("Pro免费试用截止：")}
              {new Date(trialEndsAt).toLocaleString(intlLocale(locale))}
            </p>
          )}
          <strong>
            {t("当前方案：")}
            {plan === "pro" ? "Pro" : plan === "free" ? "Free" : "—"}
          </strong>
          <p>{t("使用下方平台订阅申请付款，平台核实到账后开通服务。")}</p>
          <small>
            {t(
              "如曾开通自动扣款，请联系平台取消旧订阅；本页不会自动取消Stripe订阅。",
            )}
          </small>
        </section>
      </div>
    </>
  );
}
interface OrderSummary {
  online_enabled: boolean;
  requires_review: boolean;
  order_status: string;
}
export function OrderPayment({
  slug,
  reference,
  token,
  status,
  onRefresh,
}: {
  slug: string;
  reference: string;
  token: string;
  status: string;
  onRefresh: () => Promise<void>;
}) {
  const { t, locale, errorText } = useI18n();
  const [summary, setSummary] = useState<OrderSummary | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const api = storeApi;
  const generation = useRef(0);
  async function load() {
    if (!stripeAutomationEnabled) return;
    const current = generation.current;
    try {
      const next = await api<OrderSummary>("payments/order-summary", {
        slug,
        reference,
        token,
      });
      if (current !== generation.current) return;
      setSummary(next);
      if (next.order_status !== status) await onRefresh();
    } catch {
      /* Old deployments continue to allow manual payment; never invent readiness. */
    }
  }
  useEffect(() => {
    if (!supabase || !stripeAutomationEnabled) return;
    generation.current++;
    setSummary(null);
    let active = true;
    load();
    let tries = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (new URLSearchParams(window.location.search).has("payment_return"))
      timer = setInterval(() => {
        if (active && tries++ < 24) load();
        else if (timer) clearInterval(timer);
      }, 5000);
    return () => {
      generation.current++;
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [slug, reference, token, status]);
  async function pay() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        url: string;
      }>("payments/checkout", { reference, token });
      window.location.assign(stripeRedirect(result.url, "checkout"));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  if (!summary && stripeAutomationEnabled) return null;
  return (
    <div style={{ margin: "22px 0" }}>
      {summary?.requires_review ? (
        <ErrorBox
          error={t("付款需要商家核查，请勿重复付款。请联系商家处理。")}
        />
      ) : status === "pending" &&
        stripeConnectEnabled &&
        summary?.online_enabled ? (
        <>
          <button className="button full" disabled={busy} onClick={pay}>
            <CreditCard size={17} />
            {busy ? t("正在打开安全付款页…") : t("前往安全付款页")}
          </button>
          <p className="fine-print">
            {t(
              "实际可用支付方式以收款页面为准，返回本页不会自动当作付款成功。",
            )}
          </p>
        </>
      ) : null}
      <button
        className="text-button"
        onClick={async () => {
          try {
            await load();
            await onRefresh();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {t("刷新订单与付款状态")}
      </button>
      <ErrorBox error={error} />
    </div>
  );
}
