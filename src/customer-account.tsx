import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import {
  customerApi,
  customerClient,
  customerRecovery,
} from "./customer-store-api";
import { authRedirectUrl } from "./auth-redirect";
import { dateLabel, money, statusLabel } from "./api";
import { useI18n } from "./i18n";
import { Brand, ErrorBox, Loading } from "./ui";
interface Purchase {
  reference: string;
  status: string;
  total: number;
  created: string;
  access_token: string;
  store_name: string;
  slug: string;
  quantity: number;
}
interface History {
  summary: {
    order_count: number;
    paid_total: number;
    refunded_total: number;
    purchased_quantity: number;
    pending_count: number;
  };
  orders: Purchase[];
}
export function CustomerAccount() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const [user, setUser] = useState<User | null>(null),
    [initial, setInitial] = useState(true),
    [history, setHistory] = useState<History | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [register, setRegister] = useState(false),
    [recover, setRecover] = useState(customerRecovery);
  const epoch = useRef(0);
  const base = "/shop/" + encodeURIComponent(slug);
  const callback = () =>
    new URL("shop/" + encodeURIComponent(slug) + "/account", authRedirectUrl())
      .href;
  useEffect(() => {
    if (!customerClient) {
      setInitial(false);
      return;
    }
    let live = true;
    customerClient.auth.getSession().then(({ data }) => {
      if (live) {
        setUser(data.session?.user || null);
        setInitial(false);
      }
    });
    const { data } = customerClient.auth.onAuthStateChange((event, session) => {
      if (live) {
        setUser(session?.user || null);
        if (event === "PASSWORD_RECOVERY") setRecover(true);
      }
    });
    return () => {
      live = false;
      epoch.current++;
      data.subscription.unsubscribe();
    };
  }, []);
  async function load() {
    const current = ++epoch.current;
    try {
      const data = await customerApi<History>("history", { slug });
      if (current === epoch.current) setHistory(data);
    } catch (e) {
      if (current === epoch.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    epoch.current++;
    setHistory(null);
    setError("");
    if (!user || recover) return;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      epoch.current++;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [user?.id, slug, recover]);
  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerClient) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const credentials = {
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
      };
      if (register) {
        const { error } = await customerClient.auth.signUp({
          ...credentials,
          options: {
            emailRedirectTo: callback(),
            data: { account_type: "customer" },
          },
        });
        if (error) throw error;
        setNotice("注册请求已提交，请查看邮箱完成验证后登录。");
      } else {
        const { error } =
          await customerClient.auth.signInWithPassword(credentials);
        if (error) throw error;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!customerClient) return false;
    setBusy(true);
    setError("");
    try {
      const { error } = await customerClient.auth.signOut({ scope: "local" });
      if (error) throw error;
      epoch.current++;
      setUser(null);
      setHistory(null);
      setRecover(false);
      setNotice("");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function resetRequest() {
    if (!customerClient) return;
    const email = window.prompt(t("请输入顾客账号邮箱"));
    if (!email) return;
    setBusy(true);
    setError("");
    try {
      const { error } = await customerClient.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: callback() },
      );
      if (error) throw error;
      setNotice("如果该邮箱已注册，我们会发送重设密码链接。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerClient) return;
    const form = new FormData(event.currentTarget),
      password = String(form.get("password"));
    if (password !== String(form.get("confirmation"))) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error } = await customerClient.auth.updateUser({ password });
      if (error) throw error;
      if (!(await logout())) {
        setNotice("密码已更新，但退出会话未完成。请关闭此窗口后重新登录。");
        return;
      }
      setNotice("密码已更新，请使用新密码登录。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function claim(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await customerApi("claim", {
        slug,
        reference: String(form.get("reference")).trim(),
        token: String(form.get("token")).trim(),
      });
      await load();
      setNotice("订单已关联到你的账号。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="store-shell">
      <Brand to={base} />
      <section className="card payment-panel">
        <h1>{t("我的购买记录")}</h1>
        <p>{t("仅显示此店铺与你账号关联的订单，未付款不计入消费。")}</p>
        <Link className="text-button" to={base}>
          {t("返回店铺")}
        </Link>
        <ErrorBox error={error} />
        {notice && (
          <p className="success" role="status">
            {t(notice)}
          </p>
        )}
        {initial ? (
          <Loading />
        ) : !customerClient ? (
          <p>{t("顾客账号暂不可用，请使用订单查询凭证。")}</p>
        ) : recover ? (
          <form onSubmit={changePassword}>
            <label>
              {t("新密码")}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={256}
              />
            </label>
            <label>
              {t("再次输入新密码")}
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={256}
              />
            </label>
            <button className="button" disabled={busy}>
              {t("保存新密码")}
            </button>
          </form>
        ) : !user ? (
          <form onSubmit={authenticate}>
            <h2>{t(register ? "注册顾客账号" : "顾客登录")}</h2>
            <label>
              {t("邮箱地址")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={200}
              />
            </label>
            <label>
              {t("密码")}
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={10}
                maxLength={256}
              />
            </label>
            <div className="row">
              <button className="button" disabled={busy}>
                {t(register ? "注册顾客账号" : "顾客登录")}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setRegister(!register)}
              >
                {t(register ? "立即登录" : "注册顾客账号")}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={resetRequest}
              >
                {t("忘记密码？")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="row between">
              <span>{user.email}</span>
              <button className="text-button" disabled={busy} onClick={logout}>
                {t("退出登录")}
              </button>
            </div>
            {history && (
              <>
                <div className="metric-grid">
                  <article className="card metric">
                    <span>{t("已付款消费")}</span>
                    <strong>{money(history.summary.paid_total, locale)}</strong>
                  </article>
                  <article className="card metric">
                    <span>{t("已购买件数")}</span>
                    <strong>{history.summary.purchased_quantity}</strong>
                  </article>
                  <article className="card metric">
                    <span>{t("已退款金额")}</span>
                    <strong>
                      {money(history.summary.refunded_total, locale)}
                    </strong>
                  </article>
                  <article className="card metric">
                    <span>{t("待付款订单")}</span>
                    <strong>{history.summary.pending_count}</strong>
                  </article>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("订单编号")}</th>
                        <th>{t("数量")}</th>
                        <th>{t("金额")}</th>
                        <th>{t("付款状态")}</th>
                        <th>{t("操作")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.orders.map((o) => (
                        <tr key={o.reference}>
                          <td>
                            {o.reference}
                            <small>{dateLabel(o.created, locale)}</small>
                          </td>
                          <td>{o.quantity}</td>
                          <td>{money(o.total, locale)}</td>
                          <td>{t(statusLabel(o.status))}</td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => {
                                sessionStorage.setItem(
                                  "ezshop:order:" + o.reference,
                                  o.access_token,
                                );
                                navigate(
                                  "/shop/" +
                                    encodeURIComponent(o.slug) +
                                    "/order-result?ref=" +
                                    encodeURIComponent(o.reference),
                                );
                              }}
                            >
                              {t("查看详情")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted">
                  {t("汇总统计全部关联订单，列表最多显示最近200笔。")}
                </p>
              </>
            )}
            <form onSubmit={claim}>
              <h2>{t("关联以前的访客订单")}</h2>
              <p>
                {t("需要订单查询凭证，且订单邮箱须与你已验证的账号邮箱一致。")}
              </p>
              <label>
                {t("订单编号")}
                <input name="reference" required maxLength={100} />
              </label>
              <label>
                {t("订单查询凭证")}
                <input
                  name="token"
                  type="password"
                  autoComplete="off"
                  required
                  maxLength={128}
                />
              </label>
              <button className="button secondary" disabled={busy}>
                {t("关联订单")}
              </button>
              <button type="button" className="text-button" onClick={load}>
                {t("刷新记录")}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

export function CustomerCheckoutHint({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [signed, setSigned] = useState(false);
  useEffect(() => {
    if (!customerClient) return;
    let live = true;
    customerClient.auth.getSession().then(({ data }) => {
      if (live) setSigned(!!data.session?.user.email_confirmed_at);
    });
    const { data } = customerClient.auth.onAuthStateChange(
      (_event, session) => {
        if (live) setSigned(!!session?.user.email_confirmed_at);
      },
    );
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);
  if (!customerClient) return null;
  return (
    <div className="soft-note">
      {signed ? (
        t("本次订单将自动保存到你的顾客账号。")
      ) : (
        <>
          {t("登录顾客账号可跨设备查看购买记录，也可以访客下单。")}{" "}
          <Link
            className="text-button"
            to={"/shop/" + encodeURIComponent(slug) + "/account"}
          >
            {t("顾客登录")}
          </Link>
        </>
      )}
    </div>
  );
}
