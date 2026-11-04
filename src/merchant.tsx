import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
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
import { api, money, statusLabel, dateLabel } from "./api";
import type { Dashboard, Product, Order, OrderResult } from "./types";
import { Brand, Empty, ErrorBox, Loading, Modal } from "./ui";
import { Team, Platform, Affiliate, Notifications } from "./management";
type Tab =
  | "dashboard"
  | "products"
  | "orders"
  | "agents"
  | "settings"
  | "team"
  | "platform"
  | "notifications";
export function MerchantApp() {
  const [data, setData] = useState<Dashboard | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [tab, setTab] = useState<Tab>("dashboard"),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState<"product" | "agent" | null>(null),
    [editing, setEditing] = useState<Product | null>(null),
    [detail, setDetail] = useState<OrderResult | null>(null),
    [notice, setNotice] = useState(""),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  async function refresh() {
    setData(await api<Dashboard>("dashboard"));
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
    setBusy(true);
    setError("");
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (modal === "product")
        await api(editing ? "products/update" : "products", {
          ...form,
          price: Math.round(Number(form.price) * 100),
          stock: Number(form.stock),
          published: form.published === "on" ? 1 : 0,
          featured: form.featured === "on" ? 1 : 0,
          ...(editing ? { id: editing.id, version: editing.version } : {}),
        });
      else if (modal === "agent")
        await api("agents", { ...form, rate: Number(form.rate) });
      else await api("settings", form);
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
        action === "paid"
          ? "请核对银行实际到账。确认此订单已收款？"
          : "确认取消此未付款订单并恢复库存？",
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
    { id: "agents", name: "代理与佣金", icon: Users },
    { id: "settings", name: "店铺设置", icon: Settings },
    { id: "notifications", name: "邮件通知", icon: ShoppingBag },
    { id: "team", name: "团队与权限", icon: Users },
    { id: "platform", name: "平台管理", icon: LayoutDashboard },
  ] as const;
  if (loading) return <Loading />;
  if (!data)
    return (
      <div className="auth-layout">
        <section className="auth-story">
          <Brand />
          <span className="eyebrow">YOUR BUSINESS, SIMPLIFIED</span>
          <h1>
            好生意，
            <br />
            从简单开始。
          </h1>
          <p>
            开一家属于你的线上商店。
            <br />
            从商品、订单到代理佣金，
            <br />
            每一步都井井有条。
          </p>
          <div className="auth-art">
            <ShoppingBag size={95} strokeWidth={1} />
            <span>为马来西亚商家而生 ✦</span>
          </div>
        </section>
        <section className="auth-panel">
          <form onSubmit={auth}>
            <span className="eyebrow">WELCOME TO EZSHOP</span>
            <h1>{register ? "创建你的店铺" : "欢迎回来 👋"}</h1>
            <p>
              {register
                ? "让你的第一笔线上生意，从这里开始。"
                : "登录工作台，看看今天的生意。"}
            </p>
            {register && (
              <>
                <label>
                  店铺名称
                  <input
                    name="name"
                    required
                    maxLength={80}
                    placeholder="例如：Kedai Kita"
                  />
                </label>
                <label>
                  店铺网址标识
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
              邮箱地址
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@company.com"
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={register ? 10 : 1}
                maxLength={256}
                required
                placeholder={register ? "至少 10 个字符" : "输入你的密码"}
              />
            </label>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {busy ? "请稍候…" : register ? "创建店铺" : "登录工作台"}
              <ArrowRight size={17} />
            </button>
            <div className="auth-switch">
              {register ? "已有账号？" : "还没有店铺？"}
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setRegister(!register);
                  setError("");
                }}
              >
                {register ? "立即登录" : "免费注册"}
              </button>
            </div>
            <div className="soft-note">
              本地开发模式 · 当前通过商家手动确认收款
            </div>
          </form>
        </section>
      </div>
    );
  if (data.merchant.role === "agent")
    return <Affiliate data={data} logout={logout} />;
  const role = data.merchant.role || "owner";
  const visibleTabs = tabs.filter(
    (t) =>
      t.id === "dashboard" ||
      (t.id === "platform"
        ? role === "owner" && data.merchant.is_admin
        : t.id === "team" ||
            t.id === "settings" ||
            t.id === "agents" ||
            t.id === "notifications"
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
            <th>订单编号</th>
            <th>顾客</th>
            <th>下单时间（马来西亚）</th>
            <th>金额</th>
            <th>付款状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="purple font-medium">{o.reference}</td>
              <td>
                {o.customer}
                <small>{o.email}</small>
              </td>
              <td>{dateLabel(o.created)}</td>
              <td>{money(o.total)}</td>
              <td>
                <span className={"badge " + o.status}>
                  {statusLabel(o.status)}
                </span>
              </td>
              <td>
                <button className="text-button" onClick={() => showOrder(o.id)}>
                  查看详情 <ChevronRight size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty>暂无订单。分享店铺链接，开始接收第一笔订单。</Empty>
      )}
    </div>
  );
  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <Brand />
        <span className="nav-caption">商家工作台</span>
        <nav>
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setTab(t.id);
                setError("");
                setNotice("");
              }}
            >
              <t.icon size={19} />
              {t.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="upgrade-card">
            <span>✦</span>
            <strong>你的生意，你的节奏。</strong>
            <p>分享店铺链接，让顾客随时随地下单。</p>
            <Link to={shop}>
              查看我的店铺 <ArrowUpRight size={14} />
            </Link>
          </div>
          <button className="nav-item" onClick={logout}>
            <LogOut size={18} />
            退出登录
          </button>
        </div>
      </aside>
      <section className="dashboard-main">
        <header className="dashboard-header">
          <p>
            工作台 <ChevronRight size={14} />{" "}
            <span>{tabs.find((t) => t.id === tab)?.name}</span>
          </p>
          <div className="profile">
            <span>
              {data.merchant.name}
              <small>商家账号</small>
            </span>
            <div className="avatar">{data.merchant.name.slice(0, 1)}</div>
          </div>
        </header>
        <main className="workspace">
          <ErrorBox error={error} />
          {notice && (
            <div className="success" role="status">
              <Check size={16} />
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                关闭
              </button>
            </div>
          )}
          {tab === "dashboard" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">BUSINESS OVERVIEW</span>
                  <h1>生意总览</h1>
                  <p>每一笔订单，都是生意的新进展。</p>
                </div>
                <Link className="button secondary" to={shop} target="_blank">
                  <ArrowUpRight size={17} />
                  查看我的店铺
                </Link>
              </div>
              <div className="metric-grid">
                {[
                  {
                    name: "总销售额",
                    value: money(sales),
                    note: "仅统计已确认付款订单",
                    icon: Wallet,
                    color: "purple",
                  },
                  {
                    name: "订单总数",
                    value: data.orders.length,
                    note: "顾客提交的全部订单",
                    icon: ShoppingBag,
                    color: "green",
                  },
                  {
                    name: "待收款金额",
                    value: money(pending.reduce((s, o) => s + o.total, 0)),
                    note: pending.length + " 笔订单等待付款",
                    icon: Clock,
                    color: "orange",
                  },
                  {
                    name: "代理佣金",
                    value: money(commission),
                    note: "已付款订单累计佣金",
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
                <section className="card">
                  <div className="card-heading">
                    <h2>销售概况</h2>
                    <span className="muted">累计已付款订单</span>
                  </div>
                  <div className="sales-visual">
                    <div className="sales-orbit">
                      <BarChart3 size={48} strokeWidth={1.5} />
                    </div>
                    <div>
                      <span className="muted">已确认销售额</span>
                      <h2>{money(sales)}</h2>
                      <p>
                        {paid.length} 笔已付款 · {pending.length} 笔待付款
                      </p>
                      <small>以商家实际核实到账记录为准</small>
                    </div>
                  </div>
                </section>
                <section className="card">
                  <div className="card-heading">
                    <h2>快捷操作</h2>
                    <span className="purple">✧</span>
                  </div>
                  <div className="quick-actions">
                    {["owner", "manager", "inventory"].includes(role) && (
                      <button onClick={addProduct}>
                        <span>
                          <Plus size={20} />
                        </span>
                        <div>
                          <strong>添加新商品</strong>
                          <small>让顾客发现你的好产品</small>
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
                        <strong>分享店铺</strong>
                        <small>复制链接，开始接收订单</small>
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
                          <strong>添加销售代理</strong>
                          <small>与伙伴一起拓展生意</small>
                        </div>
                        <ArrowRight size={17} />
                      </button>
                    )}
                  </div>
                </section>
              </div>
              <section className="card">
                <div className="card-heading">
                  <h2>最近订单</h2>
                  <button
                    className="text-button"
                    onClick={() => setTab("orders")}
                  >
                    查看全部 <ArrowRight size={14} />
                  </button>
                </div>
                {orderTable(data.orders.slice(0, 5))}
              </section>
            </>
          )}
          {tab === "notifications" && <Notifications />}
          {tab === "team" && <Team />}
          {tab === "platform" && <Platform />}
          {tab === "products" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>商品管理</h1>
                  <p>把好产品，带给更多顾客。</p>
                </div>
                <button className="button" onClick={addProduct}>
                  <Plus size={17} />
                  添加商品
                </button>
              </div>
              <div className="search">
                <Search size={17} />
                <input
                  aria-label="搜索商品"
                  placeholder="搜索商品名称…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="products-grid admin-products">
                {data.products
                  .filter((p) => p.name.includes(query))
                  .map((p) => (
                    <article className="card" key={p.id}>
                      <div className="product-image">
                        {p.image ? (
                          <img src={p.image} alt={p.name} />
                        ) : (
                          <span>{p.emoji}</span>
                        )}
                        <span className="product-status">
                          {p.published === 0 ? "未发布" : "已发布"}
                        </span>
                      </div>
                      <div className="product-info">
                        <small>{p.category || "全部商品"}</small>
                        <h3>{p.name}</h3>
                        <div className="row between">
                          <strong className="purple">{money(p.price)}</strong>
                          <span className="muted">库存 {p.stock} 件</span>
                        </div>
                        <button
                          className="button secondary full small-button"
                          onClick={() => {
                            setEditing(p);
                            setModal("product");
                            setError("");
                          }}
                        >
                          编辑商品
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
              {!data.products.length && (
                <Empty>还没有商品。点击「添加商品」开始。</Empty>
              )}
            </>
          )}
          {tab === "orders" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>订单管理</h1>
                  <p>每笔订单的进展，清楚掌握。</p>
                </div>
                <select
                  aria-label="筛选订单"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">全部状态</option>
                  <option value="pending">待付款</option>
                  <option value="paid">已付款</option>
                  <option value="cancelled">已取消</option>
                </select>
              </div>
              <div className="soft-note">
                确认收款前请核对实际到账，当前尚未连接自动支付回调。
              </div>
              <section className="card">
                {orderTable(
                  data.orders.filter(
                    (o) => filter === "all" || o.status === filter,
                  ),
                )}
              </section>
            </>
          )}
          {tab === "agents" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>代理与佣金</h1>
                  <p>让每一份推广，都有清晰的回报。</p>
                </div>
                <button
                  className="button"
                  onClick={() => {
                    setModal("agent");
                    setError("");
                  }}
                >
                  <Plus size={17} />
                  添加代理
                </button>
              </div>
              <div className="soft-note">
                当前支持推广链接、订单归属与已付款佣金统计。代理独立登录、提现和结算尚未开放。
              </div>
              <section className="card table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>代理</th>
                      <th>佣金比例</th>
                      <th>订单数</th>
                      <th>已赚佣金</th>
                      <th>推广链接</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => (
                      <tr key={a.id}>
                        <td>{a.name}</td>
                        <td>{a.rate}%</td>
                        <td>{a.orders_count}</td>
                        <td>{money(a.earned)}</td>
                        <td>
                          <Link
                            className="text-button"
                            to={shop + "?agent=" + a.code}
                            target="_blank"
                          >
                            打开专属店铺 <ArrowUpRight size={14} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.agents.length && (
                  <Empty>添加第一位代理，生成专属销售链接。</Empty>
                )}
              </section>
            </>
          )}
          {tab === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>店铺设置</h1>
                  <p>把你的店铺故事，告诉每一位顾客。</p>
                </div>
              </div>
              <form className="card settings-form" onSubmit={save}>
                <h2>基本资料</h2>
                <label>
                  店铺名称
                  <input
                    name="name"
                    required
                    maxLength={80}
                    defaultValue={data.merchant.name}
                  />
                </label>
                <label>
                  店铺简介
                  <textarea
                    name="description"
                    maxLength={500}
                    rows={4}
                    defaultValue={data.merchant.description}
                  />
                </label>
                <label>
                  商家 Logo 图片 HTTPS 网址
                  <input
                    name="logo"
                    type="url"
                    pattern="https://.*"
                    defaultValue={data.merchant.logo}
                  />
                </label>
                <label>
                  商店 Banner 图片 HTTPS 网址
                  <input
                    name="banner"
                    type="url"
                    pattern="https://.*"
                    defaultValue={data.merchant.banner}
                  />
                </label>
                <label>
                  公开 WhatsApp 联系电话
                  <input
                    name="phone"
                    type="tel"
                    pattern="[+]?[0-9]{8,15}"
                    maxLength={16}
                    placeholder="+60123456789"
                    defaultValue={data.merchant.phone}
                  />
                </label>
                <p className="muted">简介及电话会显示在公开商店。</p>
                <div className="soft-note">
                  店铺网址：
                  <Link to={shop}>
                    {location.origin +
                      import.meta.env.BASE_URL.replace(/\/$/, "") +
                      shop}
                  </Link>
                  <br />
                  交易币种：MYR · 马来西亚令吉
                </div>
                <button className="button" disabled={busy}>
                  保存店铺资料
                </button>
              </form>
            </>
          )}
          <footer className="dashboard-footer">
            © {new Date().getFullYear()} EZShop · Made for Malaysian businesses
          </footer>
        </main>
      </section>
      {modal && (
        <Modal
          title={
            modal === "product"
              ? editing
                ? "编辑商品"
                : "添加商品"
              : "添加销售代理"
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
                  商品名称
                  <input
                    name="name"
                    required
                    maxLength={120}
                    defaultValue={editing?.name}
                  />
                </label>
                <div className="form-grid">
                  <label>
                    价格（MYR）
                    <input
                      name="price"
                      type="number"
                      min="0.01"
                      step="0.01"
                      max="1000000"
                      required
                      defaultValue={editing ? editing.price / 100 : ""}
                    />
                  </label>
                  <label>
                    可售库存
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
                  商品介绍
                  <textarea
                    name="description"
                    maxLength={2000}
                    rows={3}
                    defaultValue={editing?.description}
                  />
                </label>
                <label>
                  分类
                  <input
                    name="category"
                    maxLength={80}
                    defaultValue={editing?.category || "全部商品"}
                  />
                </label>
                <label>
                  商品图片 HTTPS 网址
                  <input
                    name="image"
                    type="url"
                    pattern="https://.*"
                    defaultValue={editing?.image}
                  />
                </label>
                <label>
                  无图片时使用的图标
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
                  发布到顾客端店铺
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="featured"
                    defaultChecked={editing?.featured === 1}
                  />
                  列入热门精选
                </label>
                <p className="muted">
                  修改价格不影响已有订单；库存变动后请刷新再编辑。
                </p>
              </>
            ) : (
              <>
                <label>
                  代理名称
                  <input name="name" required maxLength={80} />
                </label>
                <label>
                  佣金比例（%）
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
            <button className="button full" disabled={busy}>
              {busy ? "正在保存…" : "保存"}
            </button>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal title="订单详情" close={() => setDetail(null)}>
          <p className="purple">
            {detail.order.reference} · {statusLabel(detail.order.status)}
          </p>
          <div className="order-info">
            <div>
              <small>顾客</small>
              <p>{detail.order.customer}</p>
              <p>{detail.order.email}</p>
              <p>{detail.order.phone}</p>
            </div>
            <div>
              <small>收货地址</small>
              <p>{detail.order.address}</p>
              <small>订单备注</small>
              <p>{detail.order.note || "无"}</p>
            </div>
          </div>
          {detail.items.map((i, n) => (
            <div className="summary-line" key={n}>
              <span>
                {i.name} × {i.quantity}
                <small>{money(i.price)} / 件</small>
              </span>
              <strong>{money(i.price * i.quantity)}</strong>
            </div>
          ))}
          <div className="summary-total">
            <strong>订单总额</strong>
            <strong>{money(detail.order.total)}</strong>
          </div>
          <p className="muted">
            代理：{detail.order.agent_name || "无"} · 佣金{" "}
            {money(detail.order.commission)}
          </p>
          <ErrorBox error={error} />
          {detail.order.status === "paid" && (
            <button
              className="button secondary"
              style={{ marginTop: 20 }}
              onClick={() => window.print()}
            >
              打印收款记录
            </button>
          )}
          {detail.order.status === "pending" && (
            <div className="row end">
              <button
                className="button secondary danger"
                disabled={busy}
                onClick={() => orderAction(detail.order, "cancel")}
              >
                取消订单
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => orderAction(detail.order, "paid")}
              >
                确认收款
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
