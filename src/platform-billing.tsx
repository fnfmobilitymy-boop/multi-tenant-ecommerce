import { useEffect, useState } from "react";
import { api, supabase, dateLabel } from "./api";
import { useI18n } from "./i18n";
import { ErrorBox, Loading, Modal } from "./ui";
import { ImageUpload } from "./image-upload";
const labels: Record<string, string> = {
  bank_transfer: "Hong Leong Bank 转账",
  tng: "Touch ’n Go / DuitNow",
  usdt_trc20: "USDT · TRC20（TRON）",
  stripe_link: "Stripe 收款链接",
};
interface Request {
  id: number;
  method: string;
  amount: string | number;
  currency: string;
  status: string;
  reference: string;
  instructions: {
    bank_name?: string;
    holder?: string;
    account?: string;
    identifier?: string;
    qr?: string;
    address?: string;
    network?: string;
    url?: string;
  };
  can_pay?: boolean;
  approved_until?: string;
  note?: string;
  merchant_name?: string;
  merchant_email?: string;
}
interface Config {
  bank_enabled?: boolean;
  bank_holder?: string;
  bank_account?: string;
  tng_enabled?: boolean;
  tng_holder?: string;
  tng_identifier?: string;
  tng_qr?: string;
  usdt_enabled?: boolean;
  usdt_address?: string;
  stripe_enabled?: boolean;
  stripe_link?: string;
  stripe_currency?: string;
}
const stateLabels: Record<string, string> = {
  draft: "等待付款资料",
  submitted: "等待平台核实",
  approved: "已核实并开通",
  rejected: "已拒绝",
  cancelled: "已取消",
};
export function SubscriptionApplication() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<{
      options: Record<string, boolean>;
      requests: Request[];
      paid_until?: string;
      stripe_currency?: string;
    } | null>(null),
    [method, setMethod] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    try {
      const result = await api<NonNullable<typeof data>>(
        "platform-billing/view",
        {},
      );
      setData(result);
      setMethod(
        (previous) =>
          previous ||
          Object.keys(result.options).find((key) => result.options[key]) ||
          "",
      );
    } catch {
      setError("平台订阅收款尚未启用，请联系平台管理员。");
    }
  }
  useEffect(() => {
    if (supabase) load();
  }, []);
  if (!supabase) return null;
  const active = data?.requests.find((request) =>
    ["draft", "submitted"].includes(request.status),
  );
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const f = new FormData(event.currentTarget);
      await api("platform-billing/create", {
        method,
        amount: String(f.get("amount")),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>{t("平台订阅申请")}</h2>
      <p>
        {t(
          "向 EZShop 平台支付服务费；自填金额需平台核实，并明确开通期限，不会自动续费。",
        )}
      </p>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data?.paid_until && (
        <p>
          {t("服务有效至")}：{dateLabel(data.paid_until, locale)}
        </p>
      )}
      {data && !active && (
        <form onSubmit={create}>
          {Object.values(data.options).some(Boolean) ? (
            <>
              <label>
                {t("付款方式")}
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  {Object.keys(data.options)
                    .filter((key) => data.options[key])
                    .map((key) => (
                      <option key={key} value={key}>
                        {t(labels[key])}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {t("申请金额")} (
                {method === "usdt_trc20"
                  ? "USDT"
                  : method === "stripe_link"
                    ? data?.stripe_currency || "MYR"
                    : "MYR"}
                )
                <input
                  name="amount"
                  type="number"
                  required
                  min={method === "usdt_trc20" ? "0.000001" : "0.01"}
                  step={method === "usdt_trc20" ? "0.000001" : "0.01"}
                  max="99999999"
                />
              </label>
              <button className="button" disabled={busy}>
                {t("创建订阅申请")}
              </button>
            </>
          ) : (
            <p>{t("平台尚未开放订阅付款方式。")}</p>
          )}
        </form>
      )}
      {active && (
        <>
          <h3>
            {t(labels[active.method])} · {active.currency}{" "}
            {String(active.amount)}
          </h3>
          <p>{t(stateLabels[active.status])}</p>
          {active.status === "draft" && (
            <>
              {active.can_pay === false ? (
                <p className="soft-note">
                  {t("收款资料已更新，请联系平台后再付款。")}
                </p>
              ) : (
                <>
                  <p>{active.instructions.holder}</p>
                  {active.instructions.account && (
                    <p>
                      {active.instructions.bank_name} ·{" "}
                      {active.instructions.account}
                    </p>
                  )}
                  {active.instructions.identifier && (
                    <p>{active.instructions.identifier}</p>
                  )}
                  {active.instructions.qr && (
                    <img
                      src={active.instructions.qr}
                      alt={t("平台收款二维码")}
                      style={{ width: 220, maxWidth: "100%" }}
                    />
                  )}
                  {active.instructions.address && (
                    <>
                      <p>USDT · TRC20（TRON）</p>
                      <p className="break-link">
                        {active.instructions.address}
                      </p>
                      <p className="soft-note">
                        {t(
                          "仅发送 TRC20 USDT；请核对网络及地址，网络手续费另计。",
                        )}
                      </p>
                    </>
                  )}
                  {active.instructions.url && (
                    <>
                      <a
                        className="button secondary"
                        href={stripeLink(active.instructions.url, active.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("打开 Stripe 收款页面")}
                      </a>
                      <p>
                        {t(
                          "请在 Stripe 页面填写申请金额；返回网站不代表已付款或已开通。",
                        )}
                      </p>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {active.status === "draft" && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const f = new FormData(event.currentTarget);
                  await api("platform-billing/submit", {
                    id: active.id,
                    reference: String(f.get("reference")),
                  });
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                {t("付款参考号 / 交易哈希")}
                <input
                  name="reference"
                  required
                  minLength={active.method === "usdt_trc20" ? 64 : 6}
                  maxLength={active.method === "usdt_trc20" ? 64 : 160}
                  pattern={
                    active.method === "usdt_trc20"
                      ? "[a-fA-F0-9]{64}"
                      : undefined
                  }
                />
              </label>
              <button className="button" disabled={busy}>
                {t("提交付款资料")}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(t("仅在尚未付款时取消申请；已付款请联系平台。")))
                    return;
                  try {
                    await api("platform-billing/cancel", { id: active.id });
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {t("取消申请")}
              </button>
            </form>
          )}
          {active.status === "submitted" && (
            <p role="status">
              {t("已提交，等待平台核实真实到账。此状态不代表已开通 Pro。")}
            </p>
          )}
        </>
      )}
      {data && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("金额")}</th>
                <th>{t("状态")}</th>
                <th>{t("服务有效至")}</th>
              </tr>
            </thead>
            <tbody>
              {data.requests.map((request) => (
                <tr key={request.id}>
                  <td>
                    {request.currency} {String(request.amount)}
                  </td>
                  <td>
                    {t(stateLabels[request.status])}
                    {request.note && <small>{request.note}</small>}
                  </td>
                  <td>
                    {request.approved_until
                      ? dateLabel(request.approved_until, locale)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button className="text-button" onClick={load}>
        {t("刷新记录")}
      </button>
    </section>
  );
}
export function stripeLink(value: string, id: number) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "buy.stripe.com" ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/[A-Za-z0-9]+\/?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Stripe link");
  url.searchParams.set("client_reference_id", "EZSUB-" + id);
  return url.toString();
}
export function PlatformBillingAdmin() {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<Config | null>(null),
    [requests, setRequests] = useState<Request[]>([]),
    [review, setReview] = useState<Request | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [uploads, setUploads] = useState<Record<string, boolean>>({});
  async function load() {
    try {
      const [config, queue] = await Promise.all([
        api<{ settings: Config }>("platform-billing/settings", {}),
        api<{ requests: Request[] }>("platform-billing/queue", {}),
      ]);
      setSettings(config.settings);
      setRequests(queue.requests);
    } catch {
      setError("平台订阅收款尚未启用，请联系平台管理员。");
    }
  }
  useEffect(() => {
    if (supabase) load();
  }, []);
  if (!supabase) return null;
  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <h2>{t("平台收款与订阅审核")}</h2>
      <ErrorBox error={error} />
      {settings && (
        <details>
          <summary>{t("平台收款设置")}</summary>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setError("");
              setNotice("");
              setBusy(true);
              const f = new FormData(event.currentTarget);
              const fields = [
                "bank_holder",
                "bank_account",
                "tng_holder",
                "tng_identifier",
                "tng_qr",
                "usdt_address",
                "stripe_link",
                "stripe_currency",
              ];
              const payload = Object.fromEntries(
                fields.map((key) => [key, String(f.get(key) || "")]),
              );
              try {
                await api("platform-billing/save", {
                  ...payload,
                  bank_enabled: f.get("bank_enabled") === "on",
                  tng_enabled: f.get("tng_enabled") === "on",
                  usdt_enabled: f.get("usdt_enabled") === "on",
                  stripe_enabled: f.get("stripe_enabled") === "on",
                });
                setNotice("收款资料已保存");
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="bank_enabled"
                defaultChecked={settings.bank_enabled}
              />
              {t("启用 Hong Leong Bank 转账")}
            </label>
            <div className="form-grid">
              <label>
                {t("银行收款人")}
                <input
                  name="bank_holder"
                  maxLength={100}
                  defaultValue={settings.bank_holder}
                />
              </label>
              <label>
                {t("银行账号")}
                <input
                  name="bank_account"
                  pattern="[0-9]{8,20}"
                  maxLength={20}
                  defaultValue={settings.bank_account}
                />
              </label>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="tng_enabled"
                defaultChecked={settings.tng_enabled}
              />
              {t("启用 Touch ’n Go / DuitNow")}
            </label>
            <label>
              {t("TNG 收款人")}
              <input
                name="tng_holder"
                maxLength={100}
                defaultValue={settings.tng_holder}
              />
            </label>
            <label>
              {t("TNG / DuitNow 钱包号码")}
              <input
                name="tng_identifier"
                pattern="[0-9]{8,20}"
                maxLength={20}
                defaultValue={settings.tng_identifier}
              />
            </label>
            <ImageUpload
              name="tng_qr"
              label={t("平台收款二维码")}
              initialValue={settings.tng_qr}
              onUploading={(id, value) =>
                setUploads((previous) => ({ ...previous, [id]: value }))
              }
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="usdt_enabled"
                defaultChecked={settings.usdt_enabled}
              />
              {t("启用 USDT · TRC20（TRON）")}
            </label>
            <label>
              {t("TRC20 公开收款地址")}
              <input
                name="usdt_address"
                pattern="T[1-9A-HJ-NP-Za-km-z]{33}"
                maxLength={34}
                defaultValue={settings.usdt_address}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="stripe_enabled"
                defaultChecked={settings.stripe_enabled}
              />
              {t("启用 Stripe 收款链接")}
            </label>
            <label>
              {t("Stripe 收款币种")}
              <select
                name="stripe_currency"
                defaultValue={settings.stripe_currency || "MYR"}
              >
                <option value="MYR">MYR</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <label>
              {t("Stripe 收款链接")}
              <input
                name="stripe_link"
                type="url"
                defaultValue={settings.stripe_link}
                maxLength={500}
              />
            </label>
            <button
              className="button"
              disabled={busy || Object.values(uploads).some(Boolean)}
            >
              {t("保存收款资料")}
            </button>
            {notice && <p role="status">{t(notice)}</p>}
          </form>
        </details>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("商家")}</th>
              <th>{t("金额")}</th>
              <th>{t("状态")}</th>
              <th>{t("付款参考号 / 交易哈希")}</th>
              <th>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>
                  {request.merchant_name}
                  <small>{request.merchant_email}</small>
                </td>
                <td>
                  {request.currency} {String(request.amount)}
                  <small>{t(labels[request.method])}</small>
                </td>
                <td>{t(stateLabels[request.status])}</td>
                <td className="break-link">{request.reference || "—"}</td>
                <td>
                  {request.status === "submitted" && (
                    <button
                      className="text-button"
                      onClick={() => setReview(request)}
                    >
                      {t("核实并处理")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {review && (
        <Modal title={t("核实平台订阅付款")} close={() => setReview(null)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              const f = new FormData(event.currentTarget);
              try {
                await api("platform-billing/review", {
                  id: review.id,
                  status: "approved",
                  actual_reference: String(f.get("actual_reference")),
                  actual_amount: String(f.get("actual_amount")),
                  days: Number(f.get("days")),
                  verified: f.get("verified") === "on",
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
            <p>
              {review.merchant_name} · {review.currency} {String(review.amount)}
            </p>
            <p className="break-link">{review.reference}</p>
            {review.method === "usdt_trc20" &&
              /^[a-fA-F0-9]{64}$/.test(review.reference) && (
                <a
                  href={
                    "https://tronscan.org/#/transaction/" + review.reference
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("在 TRON 浏览器核实")}
                </a>
              )}
            <label>
              {t("实际到账金额")} ({review.currency})
              <input
                name="actual_amount"
                type="number"
                min={review.currency === "USDT" ? "0.000001" : "0.01"}
                step={review.currency === "USDT" ? "0.000001" : "0.01"}
                required
              />
            </label>
            <label>
              {t("实际打款参考号")}
              <input
                name="actual_reference"
                minLength={6}
                maxLength={160}
                required
              />
            </label>
            <label>
              {t("开通天数")}
              <input
                name="days"
                type="number"
                min="1"
                max="366"
                required
                defaultValue={30}
              />
            </label>
            <label className="checkbox-label">
              <input name="verified" type="checkbox" required />
              {t("已核对银行、钱包或 Stripe 的真实到账")}
            </label>
            <ErrorBox error={error} />
            <button className="button" disabled={busy}>
              {t("确认到账并开通服务")}
            </button>
          </form>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const f = new FormData(event.currentTarget);
              setBusy(true);
              try {
                await api("platform-billing/review", {
                  id: review.id,
                  status: "rejected",
                  note: String(f.get("note")),
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
            <label>
              {t("拒绝原因")}
              <input name="note" required maxLength={500} />
            </label>
            <button className="button secondary" disabled={busy}>
              {t("拒绝申请")}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
