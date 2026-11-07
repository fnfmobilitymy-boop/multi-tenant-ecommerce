import { useI18n } from "./i18n";
import { Link } from "react-router-dom";
import { ShoppingBag, X, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
export function Brand({ to = "/" }: { to?: string }) {
  const { t, locale, errorText } = useI18n();
  return (
    <Link to={to} className="brand" aria-label="EZShop">
      <span className="brand-icon">
        <ShoppingBag size={23} />
      </span>
      <strong>
        EZ<span>Shop</span>
      </strong>
    </Link>
  );
}
export function Loading() {
  const { t, locale, errorText } = useI18n();
  return (
    <div className="empty">
      <LoaderCircle className="spin" />
      {t("正在加载…")}
    </div>
  );
}
export function ErrorBox({ error }: { error: string }) {
  const { t, locale, errorText } = useI18n();
  return error ? (
    <p className="error" role="alert">
      {errorText(error)}
    </p>
  ) : null;
}
export function Modal({
  title,
  children,
  close,
  variant = "dialog",
}: {
  variant?: "dialog" | "drawer";
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const { t, locale, errorText } = useI18n();
  return (
    <div
      className={
        "modal-backdrop" + (variant === "drawer" ? " drawer-backdrop" : "")
      }
      onClick={close}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"modal" + (variant === "drawer" ? " product-drawer" : "")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={close}
            aria-label={t("关闭")}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  const { t, locale, errorText } = useI18n();
  return <div className="empty">{children}</div>;
}
