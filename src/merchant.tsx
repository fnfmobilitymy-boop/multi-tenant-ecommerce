import { CustomerWorkspace } from "./customer-workspace";
import { SalesAnalytics } from "./sales-analytics";
import { ProductWorkspace } from "./product-workspace";
import { BatchDocuments } from "./batch-documents";
import { ShippingZones } from "./shipping-zones";
import {
  CommerceCurrency,
  RegionFields,
  initialRegion,
  currencyFactor,
  type Currency,
} from "./commerce-currency";
import { toMinor } from "../supabase/functions/_shared/currencies";
import { Bookkeeping } from "./bookkeeping";
import { SubscriptionApplication } from "./platform-billing";
import { ContentEditor } from "./content-editor";
import { I18nProvider, LanguageToolbar, useI18n } from "./i18n";
import { useEffect, useState } from "react";
import { Payouts } from "./payouts";
import { ImageUpload } from "./image-upload";
import { couriersFor } from "./delivery";
import { MerchantPayments } from "./payments";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  LayoutDashboard,
  Package,
  ShoppingBag,
  Users,
  Settings,
  LogOut,
  Plus,
  Wallet,
  Clock,
  ChevronRight,
  Search,
  Check,
  Copy,
  BarChart3,
} from "lucide-react";
import {
  api,
  money as formatMoney,
  statusLabel,
  dateLabel as formatDate,
  supabase,
} from "./api";
import type { Dashboard, Product, Order, OrderResult } from "./types";
import { Brand, Empty, ErrorBox, Loading, Modal } from "./ui";
import { Team, Affiliate, Notifications } from "./management";
type Tab =
  | "dashboard"
  | "products"
  | "customers"
  | "orders"
  | "agents"
  | "settings"
  | "team"
  | "notifications"
  | "payouts"
  | "payments"
  | "books";
export function MerchantApp() {
  const [tab, setTab] = useState<Tab>(() => {
    const query = new URLSearchParams(window.location.search);
    return query.has("connect") || query.has("billing")
      ? "payments"
      : "dashboard";
  });
  return (
    <I18nProvider audience="merchant">
      <LanguageToolbar />
      <MerchantPage tab={tab} setTab={setTab} />
    </I18nProvider>
  );
}
function MerchantPage({
  tab,
  setTab,
}: {
  tab: Tab;
  setTab: React.Dispatch<React.SetStateAction<Tab>>;
}) {
  const { t, locale, errorText } = useI18n();
  const [data, setData] = useState<Dashboard | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState<"product" | "agent" | null>(null),
    [editing, setEditing] = useState<Product | null>(null),
    [detail, setDetail] = useState<OrderResult | null>(null),
    [notice, setNotice] = useState(""),
    [refunding, setRefunding] = useState(false),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]);
  const [region, setRegion] = useState(initialRegion);
  const currency = data?.merchant.currency || "MYR";
  const money = (amount: number, loc: typeof locale) =>
    formatMoney(amount, loc, currency);
  const dateLabel = (date: string, loc: typeof locale) =>
    formatDate(date, loc, currency);
  const inputStep = currency === "VND" ? "1" : "0.01";
  const [uploads, setUploads] = useState<Record<string, boolean>>({});
  const uploading = Object.values(uploads).some(Boolean);
  function imageUploading(id: string, busy: boolean) {
    setUploads((previous) => {
      const next = { ...previous };
      if (busy) next[id] = true;
      else delete next[id];
      return next;
    });
  }
  async function refresh() {
    const next = await api<Dashboard>("dashboard");
    setData(next);
    setSelectedOrders((ids) =>
      ids.filter((id) =>
        next.orders.some(
          (o) =>
            o.id === id &&
            o.status === "paid" &&
            o.fulfillment_status !== "shipped",
        ),
      ),
    );
    setRegion({
      country: next.merchant.country_code || "MY",
      currency: next.merchant.currency || "MYR",
    });
  }
  useEffect(() => {
    refresh()
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);
  async function auth(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        register ? "register" : "login",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api("logout", {});
      setData(null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const shop = data ? "/shop/" + encodeURIComponent(data.merchant.slug) : "";
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading) {
      setError("请等待图片上传完成后再保存。");
      return;
    }
    setBusy(true);
    setError("");
    const form = Object.fromEntries(new FormData(e.currentTarget));
    const versions =
      form.content_translations === undefined
        ? {}
        : {
            content_translations: JSON.parse(String(form.content_translations)),
          };
    try {
      if (modal === "product")
        await api(editing ? "products/update" : "products", {
          ...form,
          ...versions,
          currency,
          price: toMinor(form.price, currency),
          stock: Number(form.stock),
          ...(form.unit_cost === undefined
            ? {}
            : {
                unit_cost:
                  form.unit_cost === ""
                    ? null
                    : toMinor(form.unit_cost, currency),
              }),
          category: String(form.category || "全部商品"),
          published: form.published === "on" ? 1 : 0,
          featured: form.featured === "on" ? 1 : 0,
          ...(editing ? { id: editing.id, version: editing.version } : {}),
        });
      else if (modal === "agent")
        await api("agents", { ...form, rate: Number(form.rate) });
      else {
        if (data?.merchant.shipping_fee === undefined)
          throw new Error("店铺配送设置尚未启用，请联系平台管理员完成设置。");
        await api("settings", {
          ...form,
          ...versions,
          ...(form.shipping_rules === undefined
            ? {}
            : {
                shipping_rules: JSON.parse(String(form.shipping_rules)).map(
                  (r: Record<string, unknown>) => ({
                    ...r,
                    fee: toMinor(r.fee, region.currency),
                  }),
                ),
              }),
          shipping_fee:
            form.shipping_fee === undefined
              ? data?.merchant.shipping_fee || 0
              : toMinor(form.shipping_fee, region.currency),
        });
      }
      await refresh();
      setModal(null);
      setEditing(null);
      setNotice("资料已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function orderAction(o: Order, action: "paid" | "cancel") {
    if (
      !confirm(
        t(
          action === "paid"
            ? "请核对银行实际到账。确认此订单已收款？"
            : "确认取消此未付款订单并恢复库存？",
        ),
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api("orders/" + action, { id: o.id });
      await refresh();
      setDetail(null);
      setNotice(action === "paid" ? "已确认收款" : "订单已取消，库存已恢复");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function showOrder(id: number) {
    try {
      setRefunding(false);
      setDetail(await api<OrderResult>("orders/detail?id=" + id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function addProduct() {
    setEditing(null);
    setModal("product");
    setError("");
  }
  const tabs = [
    { id: "dashboard", name: "生意总览", icon: LayoutDashboard },
    { id: "products", name: "商品管理", icon: Package },
    { id: "orders", name: "订单管理", icon: ShoppingBag },
    { id: "customers", name: "顾客管理", icon: Users },
    { id: "agents", name: "代理与佣金", icon: Users },
    { id: "settings", name: "店铺设置", icon: Settings },
    { id: "notifications", name: "邮件通知", icon: ShoppingBag },
    { id: "books", name: "收支与利润", icon: Wallet },
    { id: "payments", name: "收款与订阅", icon: Wallet },
    { id: "payouts", name: "佣金结算", icon: Wallet },
    { id: "team", name: "团队与权限", icon: Users },
  ] as const;
  if (loading) return <Loading />;
  if (!data)
    return (
      <div className="auth-layout">
        <section className="auth-story">
          <Brand />
          <span className="eyebrow">{t("YOUR BUSINESS, SIMPLIFIED")}</span>
          <h1>
            {t("好生意，")}
            <br />
            {t("从简单开始。")}
          </h1>
          <p>
            {t("开一家属于你的线上商店。")}
            <br />
            {t("从商品、订单到代理佣金，")}
            <br />
            {t("每一步都井井有条。")}
          </p>
          <div className="auth-art">
            <ShoppingBag size={95} strokeWidth={1} />
            <span>{t("为各地商家而生 ✦")}</span>
          </div>
        </section>
        <section className="auth-panel">
          <form onSubmit={auth}>
            <span className="eyebrow">{t("WELCOME TO EZSHOP")}</span>
            <h1>{register ? t("创建你的店铺") : t("欢迎回来 \uD83D\uDC4B")}</h1>
            <p>
              {register
                ? t("让你的第一笔线上生意，从这里开始。")
                : t("登录工作台，看看今天的生意。")}
            </p>
            {register && (
              <>
                <RegionFields value={region} onChange={setRegion} />
                <label>
                  {t("店铺名称")}
                  <input
                    name="name"
                    required
                    maxLength={80}
                    placeholder={t("例如：Kedai Kita")}
                  />
                </label>
                <label>
                  {t("店铺网址标识")}
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={60}
                    placeholder="kedai-kita"
                  />
                </label>
              </>
            )}
            <label>
              {t("邮箱地址")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@company.com"
              />
            </label>
            <label>
              {t("密码")}
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={register ? 10 : 1}
                maxLength={256}
                required
                placeholder={register ? t("至少 10 个字符") : t("输入你的密码")}
              />
            </label>
            {!register && supabase && (
              <div style={{ textAlign: "right", margin: "-5px 0 15px" }}>
                <Link className="text-button" to="/forgot-password">
                  {t("忘记密码？")}
                </Link>
              </div>
            )}
            <ErrorBox error={error} />
            <button className="button full" disabled={busy || uploading}>
              {busy ? t("请稍候…") : register ? t("创建店铺") : t("登录工作台")}
              <ArrowRight size={17} />
            </button>
            <div className="auth-switch">
              {register ? t("已有账号？") : t("还没有店铺？")}
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setRegister(!register);
                  setError("");
                }}
              >
                {register ? t("立即登录") : t("免费注册")}
              </button>
            </div>
            {supabase && (
              <button
                className="text-button full"
                type="button"
                disabled={busy || uploading}
                onClick={async (e) => {
                  const input =
                    e.currentTarget.form?.querySelector<HTMLInputElement>(
                      'input[name="email"]',
                    );
                  if (!input?.reportValidity()) return;
                  setBusy(true);
                  setError("");
                  setNotice("");
                  try {
                    await api("resend-confirmation", { email: input.value });
                    setNotice("验证邮件请求已提交，请检查收件箱和垃圾邮件。");
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("重新发送验证邮件")}
              </button>
            )}
            {notice && (
              <p role="status" className="success">
                {t(notice)}
              </p>
            )}
            <div className="soft-note">
              {supabase
                ? t("请先完成邮箱验证，再登录商家后台。当前由商家核实收款。")
                : t("本地开发模式 \u00B7 当前通过商家手动确认收款")}
            </div>
          </form>
        </section>
      </div>
    );
  if (data.merchant.subscription_access === false)
    return (
      <main className="store-shell">
        <Brand to="/merchant" />
        <h1>{t("Pro试用或订阅已到期，请先续费。")}</h1>
        <p>{t("历史资料已保留，续费后可继续使用。")}</p>
        {!data.merchant.role || data.merchant.role === "owner" ? (
          <>
            <MerchantPayments
              plan={data.merchant.plan}
              showManualSettings={false}
            />
            <SubscriptionApplication />
          </>
        ) : (
          <p>{t("请联系店铺所有者续费。")}</p>
        )}
        <button className="button secondary" onClick={logout}>
          {t("退出登录")}
        </button>
        <ErrorBox error={error} />
      </main>
    );
  if (data.merchant.role === "agent")
    return (
      <CommerceCurrency currency={currency}>
        <Affiliate data={data} logout={logout} />
      </CommerceCurrency>
    );
  const role = data.merchant.role || "owner";
  const visibleTabs = tabs.filter(
    (t) =>
      t.id === "dashboard" ||
      (t.id === "books" ||
      t.id === "team" ||
      t.id === "settings" ||
      t.id === "agents" ||
      t.id === "notifications" ||
      t.id === "payouts" ||
      t.id === "payments"
        ? role === "owner"
        : t.id === "products"
          ? ["owner", "manager", "inventory"].includes(role)
          : ["owner", "manager", "orders"].includes(role)),
  );
  const paid = data.orders.filter((o) => o.status === "paid"),
    pending = data.orders.filter((o) => o.status === "pending"),
    sales = paid.reduce((s, o) => s + o.total, 0),
    commission = paid.reduce((s, o) => s + o.commission, 0);
  const orderTable = (rows: Order[]) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {tab === "orders" && (
              <th>
                <input
                  type="checkbox"
                  aria-label={t("选择本页待发货订单")}
                  checked={
                    rows.some(
                      (o) =>
                        o.status === "paid" &&
                        o.fulfillment_status !== "shipped",
                    ) &&
                    rows
                      .filter(
                        (o) =>
                          o.status === "paid" &&
                          o.fulfillment_status !== "shipped",
                      )
                      .slice(0, 50)
                      .every((o) => selectedOrders.includes(o.id))
                  }
                  onChange={(e) => {
                    const ids = rows
                      .filter(
                        (o) =>
                          o.status === "paid" &&
                          o.fulfillment_status !== "shipped",
                      )
                      .slice(0, 50)
                      .map((o) => o.id);
                    setSelectedOrders((old) =>
                      e.target.checked
                        ? [...new Set([...old, ...ids])].slice(0, 50)
                        : old.filter((id) => !ids.includes(id)),
                    );
                  }}
                />
              </th>
            )}
            <th>{t("订单编号")}</th>
            <th>{t("顾客")}</th>
            <th>{t("下单时间（马来西亚）")}</th>
            <th>{t("金额")}</th>
            <th>{t("付款状态")}</th>
            <th>{t("操作")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              {tab === "orders" && (
                <td>
                  <input
                    type="checkbox"
                    aria-label={t("选择订单 {reference}", {
                      reference: o.reference,
                    })}
                    disabled={
                      o.status !== "paid" ||
                      o.fulfillment_status === "shipped" ||
                      (!selectedOrders.includes(o.id) &&
                        selectedOrders.length >= 50)
                    }
                    checked={
                      selectedOrders.includes(o.id) &&
                      o.status === "paid" &&
                      o.fulfillment_status !== "shipped"
                    }
                    onChange={(e) =>
                      setSelectedOrders((old) =>
                        e.target.checked
                          ? [...old, o.id]
                          : old.filter((id) => id !== o.id),
                      )
                    }
                  />
                </td>
              )}
              <td className="purple font-medium">{o.reference}</td>
              <td>
                {o.customer}
                <small>{o.email}</small>
              </td>
              <td>{dateLabel(o.created, locale)}</td>
              <td>{money(o.total, locale)}</td>
              <td>
                <span className={"badge " + o.status}>
                  {t(statusLabel(o.status))}
                </span>
              </td>
              <td>
                <button className="text-button" onClick={() => showOrder(o.id)}>
                  {t("查看详情")}
                  <ChevronRight size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty>{t("暂无订单。分享店铺链接，开始接收第一笔订单。")}</Empty>
      )}
    </div>
  );
  return (
    <CommerceCurrency currency={currency}>
      <div className="dashboard-layout merchant-workspace">
        <aside className="sidebar">
          <Brand />
          <span className="nav-caption">{t("商家工作台")}</span>
          <nav>
            {[
              {
                name: "经营管理",
                ids: [
                  "dashboard",
                  "products",
                  "orders",
                  "customers",
                  "books",
                  "agents",
                  "payouts",
                ],
              },
              {
                name: "店铺管理",
                ids: ["settings", "payments", "notifications", "team"],
              },
            ].map((group) => {
              const entries = visibleTabs.filter((entry) =>
                group.ids.includes(entry.id),
              );
              return entries.length ? (
                <div className="nav-section" key={group.name}>
                  <span className="nav-section-label">{t(group.name)}</span>
                  {entries.map((entry) => (
                    <button
                      key={entry.id}
                      className={
                        tab === entry.id ? "nav-item active" : "nav-item"
                      }
                      onClick={() => {
                        setTab(entry.id);
                        setError("");
                        setNotice("");
                      }}
                    >
                      <entry.icon size={19} />
                      {t(entry.name)}
                    </button>
                  ))}
                </div>
              ) : null;
            })}
          </nav>
          <div className="sidebar-bottom">
            <div className="upgrade-card">
              <span>✦</span>
              <strong>{t("你的生意，你的节奏。")}</strong>
              <p>{t("分享店铺链接，让顾客随时随地下单。")}</p>
            </div>
            <button className="nav-item" onClick={logout}>
              <LogOut size={18} />
              {t("退出登录")}
            </button>
          </div>
        </aside>
        <section className="dashboard-main">
          <header className="dashboard-header">
            <p>
              {t("工作台")}
              <ChevronRight size={14} />{" "}
              <span>
                {t(tabs.find((entry) => entry.id === tab)?.name || "工作台")}
              </span>
            </p>
            {visibleTabs.some((entry) => entry.id === "products") && (
              <button
                className="workspace-quick-search"
                onClick={() => {
                  setTab("products");
                  requestAnimationFrame(() =>
                    document.getElementById("product-search")?.focus(),
                  );
                }}
              >
                <Search size={17} />
                <span>{t("快速查找商品")}</span>
                <span className="keycap">⌕</span>
              </button>
            )}
            <div className="profile">
              <span>
                {data.merchant.name}
                <small>{t("商家账号")}</small>
              </span>
              <div className="avatar">{data.merchant.name.slice(0, 1)}</div>
            </div>
          </header>
          <main className="workspace">
            {data.merchant.trial_ends_at &&
              new Date(data.merchant.trial_ends_at).getTime() > Date.now() &&
              data.merchant.plan !== "pro" && (
                <div className="soft-note">
                  {t("Pro免费试用截止：")}
                  {dateLabel(data.merchant.trial_ends_at, locale)}
                </div>
              )}
            <ErrorBox error={error} />
            {notice && (
              <div className="success" role="status">
                <Check size={16} />
                {t(notice)}
                <button className="text-button" onClick={() => setNotice("")}>
                  {t("关闭")}
                </button>
              </div>
            )}
            {tab === "dashboard" && (
              <>
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">{t("BUSINESS OVERVIEW")}</span>
                    <h1>{t("生意总览")}</h1>
                    <p>{t("每一笔订单，都是生意的新进展。")}</p>
                  </div>
                </div>
                <div className="metric-grid">
                  {[
                    {
                      name: t("总销售额"),
                      value: money(sales, locale),
                      note: t("仅统计已确认付款订单"),
                      icon: Wallet,
                      color: "purple",
                    },
                    {
                      name: t("订单总数"),
                      value: data.orders.length,
                      note: t("顾客提交的全部订单"),
                      icon: ShoppingBag,
                      color: "green",
                    },
                    {
                      name: t("待收款金额"),
                      value: money(
                        pending.reduce((s, o) => s + o.total, 0),
                        locale,
                      ),
                      note: t("{count} 笔订单等待付款", {
                        count: pending.length,
                      }),
                      icon: Clock,
                      color: "orange",
                    },
                    {
                      name: t("代理佣金"),
                      value: money(commission, locale),
                      note: t("已付款订单累计佣金"),
                      icon: Users,
                      color: "blue",
                    },
                  ].map((m) => (
                    <section key={m.name} className="card metric">
                      <div className="row between">
                        <span>{m.name}</span>
                        <span className={"metric-icon " + m.color}>
                          <m.icon size={18} />
                        </span>
                      </div>
                      <strong>{m.value}</strong>
                      <small>{m.note}</small>
                    </section>
                  ))}
                </div>
                <div className="overview-grid">
                  <div className="overview-analytics">
                    <SalesAnalytics orders={data.orders} />
                  </div>
                  <section className="card">
                    <div className="card-heading">
                      <h2>{t("快捷操作")}</h2>
                      <span className="purple">✧</span>
                    </div>
                    <div className="quick-actions">
                      {["owner", "manager", "inventory"].includes(role) && (
                        <button onClick={addProduct}>
                          <span>
                            <Plus size={20} />
                          </span>
                          <div>
                            <strong>{t("添加新商品")}</strong>
                            <small>{t("让顾客发现你的好产品")}</small>
                          </div>
                          <ArrowRight size={17} />
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              location.origin +
                                import.meta.env.BASE_URL.replace(/\/$/, "") +
                                shop,
                            );
                            setNotice("店铺链接已复制");
                          } catch {
                            setNotice(
                              "店铺链接：" +
                                location.origin +
                                import.meta.env.BASE_URL.replace(/\/$/, "") +
                                shop,
                            );
                          }
                        }}
                      >
                        <span>
                          <Copy size={19} />
                        </span>
                        <div>
                          <strong>{t("分享店铺")}</strong>
                          <small>{t("复制链接，开始接收订单")}</small>
                        </div>
                        <ArrowRight size={17} />
                      </button>
                      {role === "owner" && (
                        <button
                          onClick={() => {
                            setModal("agent");
                            setError("");
                          }}
                        >
                          <span>
                            <Users size={20} />
                          </span>
                          <div>
                            <strong>{t("添加销售代理")}</strong>
                            <small>{t("与伙伴一起拓展生意")}</small>
                          </div>
                          <ArrowRight size={17} />
                        </button>
                      )}
                    </div>
                  </section>
                </div>
                <section className="card">
                  <div className="card-heading">
                    <h2>{t("最近订单")}</h2>
                    <button
                      className="text-button"
                      onClick={() => setTab("orders")}
                    >
                      {t("查看全部")}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {orderTable(data.orders.slice(0, 5))}
                </section>
              </>
            )}
            {tab === "customers" && (
              <CustomerWorkspace orders={data.orders} open={showOrder} />
            )}
            {tab === "books" && <Bookkeeping />}
            {tab === "payments" && (
              <>
                <MerchantPayments
                  plan={data.merchant.plan}
                  trialEndsAt={data.merchant.trial_ends_at}
                />
                <SubscriptionApplication />
              </>
            )}
            {tab === "payouts" && <Payouts />}
            {tab === "notifications" && <Notifications />}
            {tab === "team" && <Team />}
            {tab === "products" && (
              <ProductWorkspace
                products={data.products}
                query={query}
                setQuery={setQuery}
                add={addProduct}
                busy={busy}
                edit={(p) => {
                  setEditing(p);
                  setModal("product");
                  setError("");
                }}
                bulk={async (rows, published) => {
                  if (!window.confirm(t("确认更新所选商品的上架状态？")))
                    return false;
                  setBusy(true);
                  setError("");
                  try {
                    const results = await Promise.allSettled(
                      rows.map((p) =>
                        api("products/update", {
                          ...p,
                          currency,
                          published,
                          featured: p.featured || 0,
                        }),
                      ),
                    );
                    await refresh();
                    if (results.some((r) => r.status === "rejected"))
                      setError("部分商品未更新，请刷新后检查。");
                    else setNotice("商品上架状态已更新");
                    return results.every((r) => r.status === "fulfilled");
                  } catch (e) {
                    setError((e as Error).message);
                    return false;
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
            {tab === "orders" && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{t("订单管理")}</h1>
                    <p>{t("每笔订单的进展，清楚掌握。")}</p>
                  </div>
                  <select
                    aria-label={t("筛选订单")}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">{t("全部状态")}</option>
                    <option value="pending">{t("待付款")}</option>
                    <option value="paid">{t("已付款")}</option>
                    <option value="to_ship">{t("待发货（已付款）")}</option>
                    <option value="shipped">{t("已登记发货")}</option>
                    <option value="cancelled">{t("已取消")}</option>
                    <option value="refunded">{t("已退款")}</option>
                  </select>
                </div>
                <div className="soft-note">
                  {t("确认收款前请核对实际到账，当前尚未连接自动支付回调。")}
                </div>
                <section className="card">
                  <BatchDocuments
                    merchant={data.merchant}
                    orders={data.orders.filter(
                      (o) =>
                        selectedOrders.includes(o.id) &&
                        o.status === "paid" &&
                        o.fulfillment_status !== "shipped",
                    )}
                  />
                  {orderTable(
                    data.orders.filter((o) =>
                      filter === "to_ship"
                        ? o.status === "paid" &&
                          o.fulfillment_status !== "shipped"
                        : filter === "shipped"
                          ? o.fulfillment_status === "shipped"
                          : filter === "all" || o.status === filter,
                    ),
                  )}
                </section>
              </>
            )}
            {tab === "agents" && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{t("代理与佣金")}</h1>
                    <p>{t("让每一份推广，都有清晰的回报。")}</p>
                  </div>
                  <button
                    className="button"
                    onClick={() => {
                      setModal("agent");
                      setError("");
                    }}
                  >
                    <Plus size={17} />
                    {t("添加代理")}
                  </button>
                </div>
                <div className="soft-note">
                  {t(
                    "当前支持推广链接、订单归属与已付款佣金统计。代理可通过团队邀请独立登录，并在专属门户申请佣金提现。",
                  )}
                </div>
                <section className="card table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("代理")}</th>
                        <th>{t("佣金比例")}</th>
                        <th>{t("订单数")}</th>
                        <th>{t("已赚佣金")}</th>
                        <th>{t("推广链接")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.agents.map((a) => (
                        <tr key={a.id}>
                          <td>{a.name}</td>
                          <td>{a.rate}%</td>
                          <td>{a.orders_count}</td>
                          <td>{money(a.earned, locale)}</td>
                          <td>
                            <span className="break-link">
                              {location.origin +
                                import.meta.env.BASE_URL.replace(/\/$/, "") +
                                shop +
                                "?agent=" +
                                encodeURIComponent(a.code)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.agents.length && (
                    <Empty>{t("添加第一位代理，生成专属销售链接。")}</Empty>
                  )}
                </section>
              </>
            )}
            {tab === "settings" && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{t("店铺设置")}</h1>
                    <p>{t("把你的店铺故事，告诉每一位顾客。")}</p>
                  </div>
                </div>
                <form className="card settings-form" onSubmit={save}>
                  <h2>{t("基本资料")}</h2>
                  <RegionFields
                    value={region}
                    onChange={setRegion}
                    disabled={data.merchant.currency_locked}
                  />
                  <label>
                    {t("店铺名称")}
                    <input
                      name="name"
                      required
                      maxLength={80}
                      defaultValue={data.merchant.name}
                    />
                  </label>
                  <label>
                    {t("店铺简介")}
                    <textarea
                      name="description"
                      maxLength={500}
                      rows={4}
                      defaultValue={data.merchant.description}
                    />
                  </label>
                  {data.merchant.content_translations !== undefined ? (
                    <ContentEditor
                      kind="store"
                      initial={data.merchant.content_translations}
                    />
                  ) : (
                    <div className="soft-note">
                      {t("多语言内容尚未启用，请联系平台管理员。")}
                    </div>
                  )}
                  <ImageUpload
                    name="logo"
                    label={t("商家 Logo")}
                    initialValue={data.merchant.logo}
                    onUploading={imageUploading}
                  />
                  <ImageUpload
                    name="banner"
                    label={t("商店 Banner")}
                    initialValue={data.merchant.banner}
                    onUploading={imageUploading}
                    wide
                  />
                  <label>
                    {t("公开 WhatsApp 联系电话")}
                    <input
                      name="phone"
                      type="tel"
                      pattern="[+]?[0-9]{8,15}"
                      maxLength={16}
                      placeholder="+60123456789"
                      defaultValue={data.merchant.phone}
                    />
                  </label>
                  <h2 style={{ marginTop: 28 }}>{t("配送及邮费")}</h2>
                  <label>
                    {t("每单邮费（{currency}）", { currency: region.currency })}
                    <input
                      name="shipping_fee"
                      type="number"
                      min="0"
                      max="10000"
                      step={inputStep}
                      required
                      defaultValue={
                        (data.merchant.shipping_fee || 0) /
                        currencyFactor(currency)
                      }
                    />
                  </label>
                  <p className="muted">
                    {t(
                      "由你自行设定，填 0 代表免邮。只影响新订单，邮费不计入代理佣金。",
                    )}
                  </p>
                  {data.merchant.shipping_rules_enabled && (
                    <ShippingZones
                      key={data.merchant.id + region.country + region.currency}
                      rules={data.merchant.shipping_rules || []}
                      currency={region.currency}
                      country={region.country}
                    />
                  )}
                  <label>
                    {t("常用快递公司")}
                    <input
                      name="courier"
                      list="store-couriers"
                      maxLength={100}
                      defaultValue={data.merchant.courier}
                      placeholder={t("可选择或自行填写")}
                    />
                  </label>
                  <datalist id="store-couriers">
                    {couriersFor(region.country).map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                  <p className="muted">
                    {t(
                      "列表按商家国家提供常见建议，实际配送范围以邮寄公司为准。",
                    )}
                  </p>
                  <p className="muted">
                    {t(
                      "快递由你自行安排，实际公司及运单号可在发货时填写。系统不会自动报价或叫件。",
                    )}
                  </p>
                  <p className="muted" style={{ marginTop: 20 }}>
                    {t("简介及电话会显示在公开商店。")}
                  </p>
                  <div className="store-guide">
                    <strong>{t("直播卖货，怎样用店铺接单？")}</strong>
                    <ol>
                      <li>{t("先在「商品管理」添加商品、价格和库存。")}</li>
                      <li>
                        {t(
                          "把下方店铺链接放到 TikTok、Facebook 直播简介、置顶留言或 WhatsApp。",
                        )}
                      </li>
                      <li>
                        {t(
                          "顾客点链接进入店铺下单，你在「订单管理」收款核实和安排发货。",
                        )}
                      </li>
                    </ol>
                    <p>
                      {t(
                        "目前不会自动导入社交平台的商品或订单；添加社交账号不等于接通平台订单。",
                      )}
                    </p>
                  </div>
                  <div className="soft-note">
                    {t("店铺网址：")}
                    <span className="break-link">
                      {location.origin +
                        import.meta.env.BASE_URL.replace(/\/$/, "") +
                        shop}
                    </span>
                    <br />
                    {t("交易币种：{currency}", { currency })}
                  </div>
                  <button className="button" disabled={busy || uploading}>
                    {t("保存店铺资料")}
                  </button>
                </form>
              </>
            )}
            <footer className="dashboard-footer">
              © {new Date().getFullYear()}{" "}
              {t("EZShop · Made for Malaysian businesses")}
            </footer>
          </main>
        </section>
        {modal && (
          <Modal
            variant={modal === "product" ? "drawer" : "dialog"}
            title={
              modal === "product"
                ? editing
                  ? t("编辑商品")
                  : t("添加商品")
                : t("添加销售代理")
            }
            close={() => {
              setModal(null);
              setError("");
            }}
          >
            <form onSubmit={save}>
              {modal === "product" ? (
                <>
                  <label>
                    {t("商品名称")}
                    <input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={editing?.name}
                    />
                  </label>
                  <label>
                    {t("规格 / 款式（选填）")}
                    <input
                      name="variant"
                      maxLength={100}
                      defaultValue={editing?.variant}
                      placeholder={t("例如：黑色 / M 或 500ml")}
                    />
                    <small>
                      {t("不同规格分别建立商品，各自设置价格及库存。")}
                    </small>
                  </label>
                  {data.merchant.bookkeeping_enabled &&
                    ["owner", "manager"].includes(
                      data.merchant.role || "owner",
                    ) && (
                      <label>
                        {t("单位成本（{currency}）", { currency })}
                        <input
                          name="unit_cost"
                          type="number"
                          min="0"
                          step={inputStep}
                          max={100000000 / currencyFactor(currency)}
                          defaultValue={
                            editing?.unit_cost == null
                              ? ""
                              : editing.unit_cost / currencyFactor(currency)
                          }
                        />
                        <small>
                          {t("留空表示成本未知，不会当作零成本计算利润。")}
                        </small>
                      </label>
                    )}
                  <div className="form-grid">
                    <label>
                      {t("价格（{currency}）", { currency })}
                      <input
                        name="price"
                        type="number"
                        min={inputStep}
                        step={inputStep}
                        max={100000000 / currencyFactor(currency)}
                        required
                        defaultValue={
                          editing
                            ? editing.price / currencyFactor(currency)
                            : ""
                        }
                      />
                    </label>
                    <label>
                      {t("可售库存")}
                      <input
                        name="stock"
                        type="number"
                        min="0"
                        max="1000000"
                        required
                        defaultValue={editing?.stock ?? 10}
                      />
                    </label>
                  </div>
                  <label>
                    {t("商品介绍")}
                    <textarea
                      name="description"
                      maxLength={2000}
                      rows={3}
                      defaultValue={editing?.description}
                    />
                  </label>
                  <label>
                    {t("分类")}
                    <input
                      name="category"
                      maxLength={80}
                      defaultValue={editing?.category || ""}
                      placeholder={t("全部商品")}
                    />
                  </label>
                  {data.merchant.content_translations !== undefined ? (
                    <ContentEditor
                      kind="product"
                      initial={editing?.content_translations}
                    />
                  ) : (
                    <div className="soft-note">
                      {t("多语言内容尚未启用，请联系平台管理员。")}
                    </div>
                  )}
                  <ImageUpload
                    name="image"
                    label={t("商品图片")}
                    initialValue={editing?.image}
                    onUploading={imageUploading}
                    wide
                  />
                  <label>
                    {t("无图片时使用的图标")}
                    <select name="emoji" defaultValue={editing?.emoji || "📦"}>
                      {["📦", "🍪", "☕", "👕", "🎁", "🧴", "🍰"].map((e) => (
                        <option key={e}>{e}</option>
                      ))}
                    </select>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      name="published"
                      defaultChecked={editing?.published !== 0}
                    />
                    {t("发布到顾客端店铺")}
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      name="featured"
                      defaultChecked={editing?.featured === 1}
                    />
                    {t("列入热门精选")}
                  </label>
                  <p className="muted">
                    {t("修改价格不影响已有订单；库存变动后请刷新再编辑。")}
                  </p>
                </>
              ) : (
                <>
                  <label>
                    {t("代理名称")}
                    <input name="name" required maxLength={80} />
                  </label>
                  <label>
                    {t("佣金比例（%）")}
                    <input
                      name="rate"
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      required
                      defaultValue={10}
                    />
                  </label>
                </>
              )}
              <ErrorBox error={error} />
              <button className="button full" disabled={busy || uploading}>
                {busy ? t("正在保存…") : t("保存")}
              </button>
            </form>
          </Modal>
        )}
        {detail && (
          <Modal title={t("订单详情")} close={() => setDetail(null)}>
            <p className="purple">
              {detail.order.reference} · {t(statusLabel(detail.order.status))}
            </p>
            <div className="order-info">
              <div>
                <small>{t("顾客")}</small>
                <p>{detail.order.customer}</p>
                <p>{detail.order.email}</p>
                <p>{detail.order.phone}</p>
              </div>
              <div>
                <small>{t("收货地址")}</small>
                <p>{detail.order.address}</p>
                <p>
                  {[
                    detail.order.postcode,
                    detail.order.city,
                    detail.order.state,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                <small>{t("订单备注")}</small>
                <p>{detail.order.note || t("无")}</p>
              </div>
            </div>
            {detail.items.map((i, n) => (
              <div className="summary-line" key={n}>
                <span>
                  {i.name} × {i.quantity}
                  <small>
                    {money(i.price, locale)}
                    {t("/ 件")}
                  </small>
                </span>
                <strong>{money(i.price * i.quantity, locale)}</strong>
              </div>
            ))}
            <div className="summary-line">
              <span>{t("商品小计")}</span>
              <span>
                {money(detail.order.subtotal ?? detail.order.total, locale)}
              </span>
            </div>
            <div className="summary-line">
              <span>{t("邮费")}</span>
              <span>{money(detail.order.shipping || 0, locale)}</span>
            </div>
            <div className="summary-total">
              <strong>{t("订单总额")}</strong>
              <strong>{money(detail.order.total, locale)}</strong>
            </div>
            <p className="muted">
              {t("代理：")}
              {detail.order.agent_name || t("无")}
              {t("\u00B7 佣金")} {money(detail.order.commission, locale)}
            </p>
            <ErrorBox error={error} />
            {detail.order.fulfillment_status === "shipped" ? (
              <div className="soft-note">
                <strong>{t("已登记发货")}</strong>
                <p>
                  {detail.order.carrier} · {detail.order.tracking}
                </p>
              </div>
            ) : (
              detail.order.status === "paid" && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    setError("");
                    const f = Object.fromEntries(new FormData(e.currentTarget));
                    try {
                      await api("orders/ship", { id: detail.order.id, ...f });
                      await refresh();
                      setDetail(
                        await api<OrderResult>(
                          "orders/detail?id=" + detail.order.id,
                        ),
                      );
                      setNotice("发货记录已保存");
                    } catch (error) {
                      setError((error as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <h2 style={{ marginTop: 22 }}>{t("登记已寄出的包裹")}</h2>
                  <label>
                    {t("实际快递公司")}
                    <input
                      name="carrier"
                      list="shipment-couriers"
                      maxLength={100}
                      required
                      defaultValue={data.merchant.courier}
                    />
                  </label>
                  <datalist id="shipment-couriers">
                    {couriersFor(data.merchant.country_code || "MY").map(
                      (c) => (
                        <option key={c} value={c} />
                      ),
                    )}
                  </datalist>
                  <label>
                    {t("运单号")}
                    <input name="tracking" maxLength={100} required />
                  </label>
                  <p className="muted">
                    {t(
                      "请先自行寄件，再填写真实运单号。此操作不会向快递公司下单。",
                    )}
                  </p>
                  <button
                    className="button"
                    style={{ marginTop: 15 }}
                    disabled={busy}
                  >
                    {t("已寄件，保存发货记录")}
                  </button>
                </form>
              )
            )}
            {detail.order.status === "paid" && (
              <button
                className="button secondary"
                style={{ marginTop: 20 }}
                onClick={() => window.print()}
              >
                {t("打印收款记录")}
              </button>
            )}
            {detail.order.status === "paid" && role === "owner" && (
              <div style={{ marginTop: 20 }}>
                {!refunding ? (
                  <button
                    className="button secondary danger"
                    onClick={() => setRefunding(true)}
                  >
                    {t("登记已完成退款")}
                  </button>
                ) : (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      setError("");
                      const f = new FormData(e.currentTarget);
                      try {
                        await api("orders/refund", {
                          id: detail.order.id,
                          reference: String(f.get("reference")),
                          restock: f.get("restock") === "on",
                        });
                        setDetail(null);
                        setRefunding(false);
                        await refresh();
                        setNotice("退款已登记，佣金已回冲");
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <div className="soft-note">
                      {t(
                        "仅登记已在线下或支付平台实际完成的全额退款，不会发起退款转账。该订单的佣金将回冲，关联的待处理提现申请会被拒绝。",
                      )}
                    </div>
                    <label>
                      {t("实际退款参考号")}
                      <input name="reference" maxLength={200} required />
                    </label>
                    <label className="checkbox-label">
                      <input name="restock" type="checkbox" />
                      {t("已确认收回商品，恢复库存")}
                    </label>
                    <button className="button" disabled={busy || uploading}>
                      {t("已核实，登记全额退款")}
                    </button>
                  </form>
                )}
              </div>
            )}
            {detail.order.status === "pending" && (
              <div className="row end">
                <button
                  className="button secondary danger"
                  disabled={busy || uploading}
                  onClick={() => orderAction(detail.order, "cancel")}
                >
                  {t("取消订单")}
                </button>
                <button
                  className="button"
                  disabled={busy || uploading}
                  onClick={() => orderAction(detail.order, "paid")}
                >
                  {t("确认收款")}
                </button>
              </div>
            )}
          </Modal>
        )}
      </div>
    </CommerceCurrency>
  );
}
