import { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, initialPasswordRecovery, supabase } from "./api";
import { Brand, ErrorBox, Loading } from "./ui";
export function RecoveryListener() {
  const navigate = useNavigate();
  const consumed = useRef(false);
  useEffect(() => {
    if (!supabase) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (initialPasswordRecovery && !consumed.current) {
      consumed.current = true;
      navigate("/reset-password" + window.location.hash, { replace: true });
    }
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY")
        timer = setTimeout(
          () => navigate("/reset-password", { replace: true }),
          0,
        );
    });
    return () => {
      if (timer) clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, [navigate]);
  return null;
}
function message(error: unknown) {
  const value = error instanceof Error ? error.message : "";
  if (/rate limit|too many|only request|security purposes/i.test(value))
    return "操作过于频繁，请稍后再试。";
  if (/different|same password/i.test(value)) return "新密码需要与原密码不同。";
  if (/expired|session|invalid.*token|链接已失效/i.test(value))
    return "重设链接已失效，请重新申请。";
  if (/字符/.test(value)) return value;
  return "暂时无法完成，请稍后重试。";
}
export function ForgotPassword() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const email = String(new FormData(event.currentTarget).get("email"));
      await api("recover-password", { email });
      setDone(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-panel recovery-page">
      <form onSubmit={submit}>
        <Brand />
        <span className="eyebrow">ACCOUNT RECOVERY</span>
        <h1>找回密码</h1>
        <p>填写注册邮箱，我们会向已注册的账号发送重设密码链接。</p>
        {!supabase ? (
          <ErrorBox error="当前无法使用账号找回，请联系平台管理员。" />
        ) : done ? (
          <div className="success" role="status">
            若此邮箱已注册，将收到重设邮件。请检查收件箱和垃圾邮件，并使用最新链接。
          </div>
        ) : (
          <>
            <label>
              注册邮箱
              <input
                name="email"
                type="email"
                required
                maxLength={200}
                autoComplete="email"
              />
            </label>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {busy ? "正在提交…" : "发送重设邮件"}
            </button>
          </>
        )}
        <Link className="text-button" style={{ marginTop: 25 }} to="/">
          返回登录
        </Link>
      </form>
    </section>
  );
}
export function ResetPassword() {
  const [loading, setLoading] = useState(true),
    [valid, setValid] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false),
    [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (active) {
          setValid(!error && !!data.session);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const f = new FormData(event.currentTarget),
      password = String(f.get("password"));
    if (password !== f.get("confirm")) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ ok: boolean; sign_out_pending: boolean }>(
        "update-password",
        { password },
      );
      setPending(result.sign_out_pending);
      setDone(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-panel recovery-page">
      <form onSubmit={submit}>
        <Brand />
        <span className="eyebrow">RESET PASSWORD</span>
        <h1>设置新密码</h1>
        {loading ? (
          <Loading />
        ) : done ? (
          <>
            <div className="success" role="status">
              密码已更新，请使用新密码登录。
            </div>
            {pending && (
              <p className="error">
                密码已更新，但退出会话未完成。请关闭此窗口后重新登录。
              </p>
            )}
            <Link className="button full" to="/">
              返回登录
            </Link>
          </>
        ) : !valid ? (
          <>
            <ErrorBox error="重设链接已失效或缺少登录凭证，请重新申请。" />
            <Link className="button full" to="/forgot-password">
              重新申请重设邮件
            </Link>
          </>
        ) : (
          <>
            <p>请输入至少 10 个字符的新密码。成功更新后会退出账号会话。</p>
            <label>
              新密码
              <input
                name="password"
                type="password"
                minLength={10}
                maxLength={256}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              再次输入新密码
              <input
                name="confirm"
                type="password"
                minLength={10}
                maxLength={256}
                autoComplete="new-password"
                required
              />
            </label>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {busy ? "正在更新…" : "保存新密码"}
            </button>
          </>
        )}
      </form>
    </section>
  );
}
