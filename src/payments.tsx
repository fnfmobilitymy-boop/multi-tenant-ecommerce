import { storeApi } from "./customer-store-api";
import { MerchantReceiving } from "./merchant-receiving";
import { stripeAutomationEnabled, stripeConnectEnabled } from "./features";
import { intlLocale, useI18n } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { CreditCard, ShieldCheck, Wallet, RefreshCw } from "lucide-react";
import { api, supabase } from "./api";
import { ErrorBox, Loading, Modal } from "./ui";
import { stripeRedirect } from "../supabase/functions/_shared/payment-security";
interface Review {
  id: number;
  reference?: string;
  reason: string;
  resolved: boolean;
}
interface PaymentStatus {
  subscription_access?: boolean;
  manual_billing_enabled?: boolean;
  trial_ends_at?: string;
  merchant_id: number;
  account_id?: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  plan: string;
  billing: {
    status?: string;
    invoice_paid?: boolean;
    paid_through?: string;
    customer_id?: string;
  };
  reviews: Review[];
}
const reviewLabel: Record<string, string> = {
  amount_mismatch: "付款金额或币种不符",
  account_mismatch: "收款账户不匹配",
  order_state_changed: "付款时订单状态已改变",
  subscription_price_mismatch: "订阅价格需核查",
  multiple_subscriptions: "出现重复订阅",
  refund_state_changed: "退款时订单状态已改变",
  partial_refund_or_mismatch: "部分退款或退款金额需核查",
  payment_disputed: "顾客发起支付争议",
};
export function MerchantPayments({
  plan = "",
  trialEndsAt,
  showManualSettings = true,
}: {
  plan?: string;
  trialEndsAt?: string;
  showManualSettings?: boolean;
}) {
  const { t, locale, errorText } = useI18n();
  const [data, setData] = useState<PaymentStatus | null>(null),
    [error, setError] = useState(""),
    [connectError, setConnectError] = useState(""),
    [billingError, setBillingError] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<Review | null>(null);
  async function load() {
    try {
      setData(await api<PaymentStatus>("payments/status"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (supabase && stripeAutomationEnabled) load();
  }, []);
  async function action(
    name: string,
    kind?: "checkout" | "connect" | "billing",
  ) {
    setBusy(true);
    const setActionError =
      name === "connect" || name === "refresh"
        ? setConnectError
        : setBillingError;
    setActionError("");
    try {
      const result = await api<{
        url?: string;
      }>("payments/" + name, {});
      if (kind) window.location.assign(stripeRedirect(result.url, kind));
      else await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!stripeAutomationEnabled)
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
          </section>
        </div>
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t("收款与订阅")}</h1>
          <p>{t("商品款付给商家，平台服务费付给 EZShop。")}</p>
        </div>
        <CreditCard className="purple" size={25} />
      </div>
      {showManualSettings && <MerchantReceiving />}
      {!supabase ? (
        <div className="soft-note">
          {t("当前使用商家手动收款，线上支付服务尚未启用。")}
        </div>
      ) : (
        <>
          <ErrorBox error={error} />
          {!data && !error && <Loading />}
          {data && (
            <>
              <div className="overview-grid">
                {stripeConnectEnabled && data.subscription_access !== false && (
                  <section className="card payment-panel">
                    <Wallet className="purple" size={27} />
                    <h2>{t("店铺线上收款")}</h2>
                    <ErrorBox error={connectError} />
                    <p>
                      {t(
                        "通过 Stripe Connect 绑定你自己的收款账户，顾客商品款归属该账户。",
                      )}
                    </p>
                    <span
                      className={
                        "badge " + (data.charges_enabled ? "paid" : "pending")
                      }
                    >
                      {data.charges_enabled
                        ? t("已开通线上收款")
                        : t("尚未开通收款")}
                    </span>
                    <p className="muted">
                      {t("银行结算：")}
                      {data.payouts_enabled
                        ? t("账户已启用结算")
                        : t("尚待收款服务商确认")}
                    </p>
                    <div className="row">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => action("connect", "connect")}
                      >
                        {data.account_id
                          ? t("继续账户认证")
                          : t("开通商家收款账户")}
                      </button>
                      {data.account_id && (
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => action("refresh")}
                        >
                          <RefreshCw size={14} />
                          {t("检查状态")}
                        </button>
                      )}
                    </div>
                    <small>
                      {t(
                        "卡支付及 FPX 以你的账户实际开通情况为准。平台不会收集银行卡密码。",
                      )}
                    </small>
                  </section>
                )}
                <section className="card payment-panel">
                  <ShieldCheck className="purple" size={27} />
                  <h2>{t("EZShop 套餐与账单")}</h2>
                  <ErrorBox error={billingError} />
                  <p>
                    {t(
                      "这笔费用是商家使用 EZShop 的订阅服务费，与顾客购买商品的款项分开。",
                    )}
                  </p>
                  <p>{t("Pro：MYR 99.90/月，另加6%税费，共MYR 105.89/月。")}</p>
                  {data.trial_ends_at &&
                    new Date(data.trial_ends_at).getTime() > Date.now() && (
                      <p>
                        {t("Pro免费试用截止：")}
                        {new Date(data.trial_ends_at).toLocaleString(
                          intlLocale(locale),
                        )}
                      </p>
                    )}
                  <strong>
                    {t("当前方案：")}
                    {data.plan === "pro" ? "Pro" : "Free"}
                  </strong>
                  <p>
                    {t("订阅状态：")}
                    {{
                      none: t("尚无自动订阅"),
                      active: t("有效订阅"),
                      trialing: t("试用中"),
                      past_due: t("付款逾期"),
                      canceled: t("已取消"),
                      unpaid: t("未付款"),
                      incomplete: t("待完成付款"),
                      incomplete_expired: t("开通过期"),
                      requires_review: t("需要核查"),
                      paused: t("已暂停"),
                    }[data.billing.status || "none"] || data.billing.status}
                  </p>
                  {data.billing.paid_through && (
                    <p className="muted">
                      {t("账单周期结束：")}
                      {new Date(data.billing.paid_through).toLocaleDateString(
                        intlLocale(locale),
                        { timeZone: "Asia/Kuala_Lumpur" },
                      )}
                    </p>
                  )}
                  <div className="row">
                    {!data.billing.customer_id ||
                    ["none", "canceled", "incomplete_expired"].includes(
                      data.billing.status || "none",
                    ) ? (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => action("subscribe", "checkout")}
                      >
                        {t("查看价格并订阅 Pro")}
                      </button>
                    ) : null}
                    {data.billing.customer_id && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => action("portal", "billing")}
                      >
                        {t("管理付款方式与订阅")}
                      </button>
                    )}
                  </div>
                  <small>
                    {t(
                      "最终价格及扣款条款在安全订阅页面展示。未配置服务时不会扣费；手动分配 Pro 不代表订阅已付款。",
                    )}
                  </small>
                </section>
              </div>
              <section className="card">
                <div className="card-heading">
                  <h2>{t("付款核查记录")}</h2>
                  <button className="text-button" onClick={load}>
                    {t("刷新")}
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("订单")}</th>
                        <th>{t("原因")}</th>
                        <th>{t("状态")}</th>
                        <th>{t("操作")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.reviews.map((r) => (
                        <tr key={r.id}>
                          <td>{r.reference || t("订阅账单")}</td>
                          <td>
                            {reviewLabel[r.reason]
                              ? t(reviewLabel[r.reason])
                              : t("需要核查")}
                          </td>
                          <td>{r.resolved ? t("已记录处理") : t("待核实")}</td>
                          <td>
                            {!r.resolved && (
                              <button
                                className="text-button"
                                onClick={() => setReview(r)}
                              >
                                {t("登记外部处理结果")}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.reviews.length && (
                    <p className="empty">{t("暂无需要核查的付款。")}</p>
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}
      {review && (
        <Modal title={t("记录已完成的外部处理")} close={() => setReview(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const form = new FormData(e.currentTarget);
                await api("payments/resolve-review", {
                  id: review.id,
                  resolution: String(form.get("resolution")),
                });
                setReview(null);
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="soft-note">
              {t(
                "请先在收款服务商后台核实或完成退款，再记录结果。此处不会转账、退款或把订单改为已付款。",
              )}
            </div>
            <label>
              {t("处理结果及实际参考号")}
              <textarea name="resolution" required maxLength={500} rows={4} />
            </label>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {t("保存核查记录")}
            </button>
          </form>
        </Modal>
      )}
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
