import { useEffect, useState } from "react";
import { Shield, LogOut } from "lucide-react";
import { api } from "./api";
import { Link, useLocation } from "react-router-dom";
import { ForgotPassword, ResetPassword } from "./account-recovery";
import { I18nProvider, LanguageToolbar, useI18n } from "./i18n";
import { Brand, ErrorBox, Loading } from "./ui";
import { Platform } from "./management";

export function PlatformApp() {
  const { pathname } = useLocation();
  return (
    <I18nProvider audience="platform">
      <LanguageToolbar />
      {pathname === "/platform/forgot-password" ? (
        <ForgotPassword portal="platform" />
      ) : pathname === "/platform/reset-password" ? (
        <ResetPassword portal="platform" />
      ) : (
        <PlatformPage />
      )}
    </I18nProvider>
  );
}
function PlatformPage() {
  const { t } = useI18n();
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Verify with the protected platform RPC. Do not call dashboard: it may
  // bootstrap a merchant and exposes merchant data unrelated to this portal.
  async function verify() {
    await api("platform");
    setAuthorized(true);
  }
  useEffect(() => {
    verify()
      .catch(() => setAuthorized(false))
      .finally(() => setLoading(false));
  }, []);
  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("login", fields);
      await verify();
    } catch (e) {
      setAuthorized(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await api("logout", {});
      setAuthorized(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!authorized)
    return (
      <main className="auth-layout">
        <section className="auth-story">
          <Brand to="/platform" />
          <Shield size={48} />
          <h1>{t("平台管理")}</h1>
          <p>{t("需要平台管理员权限")}</p>
        </section>
        <section className="auth-panel">
          <form onSubmit={login} className="auth-form">
            <h1>{t("平台管理员登录")}</h1>
            <label>
              {t("邮箱地址")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
            <label>
              {t("密码")}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {t("立即登录")}
            </button>
            <Link className="text-button" to="/platform/forgot-password">
              {t("忘记密码？")}
            </Link>
          </form>
        </section>
      </main>
    );
  return (
    <div className="dashboard-layout" data-portal="platform">
      <aside className="sidebar">
        <Brand to="/platform" />
        <span className="nav-caption">{t("平台管理")}</span>
        <nav>
          <div className="nav-item active">
            <Shield size={19} />
            {t("平台管理")}
          </div>
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={logout} disabled={busy}>
            <LogOut size={18} />
            {t("退出登录")}
          </button>
        </div>
      </aside>
      <main className="dashboard-main">
        <header className="dashboard-header">
          <strong>{t("平台管理")}</strong>
        </header>
        <div className="workspace">
          <ErrorBox error={error} />
          <Platform />
        </div>
      </main>
    </div>
  );
}
