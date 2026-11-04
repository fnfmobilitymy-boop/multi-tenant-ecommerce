import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Users,
  Copy,
  ArrowUpRight,
  Shield,
  Wallet,
  ShoppingBag,
} from "lucide-react";
import { api, dateLabel, money, statusLabel } from "./api";
import { Brand, Empty, ErrorBox, Loading, Modal } from "./ui";
import type { Dashboard } from "./types";
const roles: Record<string, string> = {
  agent: "销售代理",
  orders: "订单客服",
  inventory: "库存专员",
  manager: "店铺经理",
};
interface Member {
  id: number;
  name: string;
  email: string;
  role: string;
  active: number;
  expires: number;
}
interface Audit {
  actor: string;
  action: string;
  object_id: number;
  created: string;
}
export function Team() {
  const [data, setData] = useState<{ members: Member[]; logs: Audit[] } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [invite, setInvite] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [role, setRole] = useState("orders");
  async function load() {
    setData(await api("team"));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const f = Object.fromEntries(new FormData(e.currentTarget));
      const r = await api<{ invite_token: string }>("team/invite", {
        ...f,
        rate: Number(f.rate || 0),
      });
      setInvite(
        location.origin +
          import.meta.env.BASE_URL.replace(/\/$/, "") +
          "/join?token=" +
          encodeURIComponent(r.invite_token),
      );
      setOpen(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: number) {
    if (!confirm("确认撤销此账号的访问权限？已登录会话也会失效。")) return;
    try {
      await api("team/revoke", { id });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>团队与权限</h1>
          <p>让合适的人，处理合适的工作。</p>
        </div>
        <button className="button" onClick={() => setOpen(true)}>
          <Plus size={17} />
          邀请成员
        </button>
      </div>
      <ErrorBox error={error} />
      {invite && (
        <div className="soft-note">
          <strong>邀请已创建 · 7 天内有效，仅限指定邮箱使用</strong>
          <p className="break-link">{invite}</p>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite);
              } catch {
                setError("请手动复制上方链接");
              }
            }}
          >
            <Copy size={14} />
            复制邀请链接
          </button>
        </div>
      )}
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name}
                  <small>{m.email}</small>
                </td>
                <td>{roles[m.role]}</td>
                <td>
                  {m.active
                    ? "已启用"
                    : m.expires * 1000 > Date.now()
                      ? "等待接受"
                      : "邀请已过期"}
                </td>
                <td>
                  <button
                    className="text-button danger"
                    onClick={() => revoke(m.id)}
                  >
                    撤销访问
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.members.length && (
          <Empty>邀请团队成员，按角色分工协作。</Empty>
        )}
        {!data && !error && <Loading />}
      </div>
      <section className="card" style={{ marginTop: 24 }}>
        <div className="card-heading">
          <h2>最近操作记录</h2>
          <span className="muted">最多 50 条</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>执行者</th>
                <th>操作</th>
                <th>对象</th>
              </tr>
            </thead>
            <tbody>
              {data?.logs.map((l, i) => (
                <tr key={i}>
                  <td>{dateLabel(l.created)}</td>
                  <td>{l.actor}</td>
                  <td>{l.action}</td>
                  <td>{l.object_id || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {open && (
        <Modal title="邀请团队成员" close={() => setOpen(false)}>
          <form onSubmit={submit}>
            <label>
              成员姓名
              <input name="name" required maxLength={80} />
            </label>
            <label>
              指定邮箱
              <input name="email" type="email" required maxLength={200} />
            </label>
            <label>
              角色
              <select
                name="role"
                aria-label="角色"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {Object.entries(roles).map(([k, n]) => (
                  <option key={k} value={k}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {role === "agent" && (
              <label>
                佣金比例（%）
                <input
                  name="rate"
                  type="number"
                  min="0"
                  max="100"
                  defaultValue={10}
                  required
                />
              </label>
            )}
            <p className="muted">
              客服仅处理订单；库存专员仅管理商品；经理可管理商品和订单；代理只查看自己的推广业绩。
            </p>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              生成安全邀请链接
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
interface PlatformMerchant {
  id: number;
  name: string;
  email: string;
  slug: string;
  plan: string;
  status: string;
  orders_count: number;
  sales: number;
}
export function Platform() {
  const [merchants, setMerchants] = useState<PlatformMerchant[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function load() {
    setMerchants(
      (await api<{ merchants: PlatformMerchant[] }>("platform")).merchants,
    );
  }
  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  async function change(m: PlatformMerchant, plan: string, status: string) {
    if (
      !confirm("确认修改商家 " + m.name + " 的方案或状态？这不会发起订阅扣款。")
    )
      return;
    try {
      await api("platform/update", { id: m.id, plan, status });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>平台管理</h1>
          <p>商家、方案及运营状态统一管理。</p>
        </div>
        <Shield size={25} className="purple" />
      </div>
      <div className="soft-note">
        方案为平台手动分配标识，不代表订阅已收款。自动订阅计费与网关尚未开通。
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>商家</th>
                <th>订单数</th>
                <th>已收款销售额</th>
                <th>方案</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    <small>{m.email}</small>
                  </td>
                  <td>{m.orders_count}</td>
                  <td>{money(m.sales)}</td>
                  <td>
                    <select
                      aria-label={m.name + " 方案"}
                      value={m.plan}
                      onChange={(e) => change(m, e.target.value, m.status)}
                    >
                      <option value="free">Free</option>
                      <option value="pro">Pro（手动分配）</option>
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={m.name + " 状态"}
                      value={m.status}
                      onChange={(e) => change(m, m.plan, e.target.value)}
                    >
                      <option value="active">正常</option>
                      <option value="suspended">暂停</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
export function Affiliate({
  data,
  logout,
}: {
  data: Dashboard;
  logout: () => void;
}) {
  const a = data.agents[0],
    paid = data.orders.filter((o) => o.status === "paid"),
    earned = paid.reduce((s, o) => s + o.commission, 0),
    link = "/shop/" + data.merchant.slug + "?agent=" + a?.code;
  return (
    <div className="store-shell">
      <div className="row between">
        <Brand />
        <button className="button secondary" onClick={logout}>
          退出登录
        </button>
      </div>
      <div className="page-heading" style={{ marginTop: 45 }}>
        <div>
          <span className="eyebrow">AFFILIATE PORTAL</span>
          <h1>你好，{a?.name || "销售伙伴"}</h1>
          <p>{data.merchant.name} · 你的专属推广工作台</p>
        </div>
      </div>
      <div className="metric-grid">
        <div className="card metric">
          <Wallet className="purple" size={22} />
          <p>已赚佣金</p>
          <strong>{money(earned)}</strong>
          <small>已确认付款订单</small>
        </div>
        <div className="card metric">
          <ShoppingBag className="purple" size={22} />
          <p>推广订单</p>
          <strong>{data.orders.length}</strong>
          <small>仅你的归属订单</small>
        </div>
        <div className="card metric">
          <Users className="purple" size={22} />
          <p>佣金比例</p>
          <strong>{a?.rate || 0}%</strong>
          <small>当前商家设置</small>
        </div>
      </div>
      <div className="soft-note">
        <strong>专属推广链接</strong>
        <p className="break-link">
          {location.origin + import.meta.env.BASE_URL.replace(/\/$/, "") + link}
        </p>
        <Link className="text-button" to={link} target="_blank">
          打开推广店铺 <ArrowUpRight size={14} />
        </Link>
        <p>提现和佣金结算尚未开放，当前金额表示已赚取，不表示已支付。</p>
      </div>
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>订单编号</th>
              <th>时间</th>
              <th>订单金额</th>
              <th>状态</th>
              <th>佣金</th>
            </tr>
          </thead>
          <tbody>
            {data.orders.map((o) => (
              <tr key={o.id}>
                <td>{o.reference}</td>
                <td>{dateLabel(o.created)}</td>
                <td>{money(o.total)}</td>
                <td>
                  <span className={"badge " + o.status}>
                    {statusLabel(o.status)}
                  </span>
                </td>
                <td>{o.status === "paid" ? money(o.commission) : "待确认"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.orders.length && (
          <Empty>分享推广链接，开始你的第一笔成交。</Empty>
        )}
      </div>
    </div>
  );
}
export function Join() {
  const [params] = useSearchParams(),
    navigate = useNavigate(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("join", {
        ...Object.fromEntries(new FormData(e.currentTarget)),
        token: params.get("token") || "",
      });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-panel" style={{ minHeight: "100vh" }}>
      <form onSubmit={submit}>
        <Brand />
        <h1 style={{ marginTop: 30 }}>
          {done ? "团队账号已启用" : "加入 EZShop 团队"}
        </h1>
        {done ? (
          <>
            <p>请使用邀请邮箱和刚设置的密码登录。</p>
            <button
              type="button"
              className="button full"
              onClick={() => navigate("/")}
            >
              前往登录
            </button>
          </>
        ) : (
          <>
            <p>请使用商家指定的邮箱接受邀请。链接仅可使用一次。</p>
            <label>
              邀请邮箱
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
              />
            </label>
            <label>
              设置密码
              <input
                name="password"
                type="password"
                minLength={10}
                maxLength={256}
                required
                autoComplete="new-password"
              />
            </label>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              接受邀请并启用账号
            </button>
          </>
        )}
      </form>
    </div>
  );
}
interface NotificationJob {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  reference: string;
  recipient: string;
  error?: string;
}
export function Notifications() {
  const [jobs, setJobs] = useState<NotificationJob[] | null>(null),
    [error, setError] = useState("");
  async function load() {
    try {
      setJobs((await api<{ jobs: NotificationJob[] }>("notifications")).jobs);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>邮件通知</h1>
          <p>收据与付款提醒的处理记录。</p>
        </div>
        <button className="button secondary" onClick={load}>
          刷新记录
        </button>
      </div>
      <div className="soft-note">
        确认收款后会自动加入收据队列。未付款提醒需定时任务运行。只有配置邮件服务并启动发送任务后才会发出；「服务商已接受」不代表客户一定收到。
      </div>
      <ErrorBox error={error} />
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>订单</th>
              <th>收件人</th>
              <th>类型</th>
              <th>状态</th>
              <th>尝试次数</th>
            </tr>
          </thead>
          <tbody>
            {jobs?.map((j) => (
              <tr key={j.id}>
                <td>{j.reference}</td>
                <td>{j.recipient}</td>
                <td>{j.kind === "receipt" ? "付款收据" : "付款提醒"}</td>
                <td>
                  {{
                    queued: "等待发送",
                    sending: "正在发送",
                    sent: "服务商已接受",
                    failed: "发送失败",
                    skipped: "已跳过",
                  }[j.status] || j.status}
                </td>
                <td>{j.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs && !jobs.length && <Empty>暂时没有通知记录。</Empty>}
        {!jobs && !error && <Loading />}
      </div>
    </>
  );
}
