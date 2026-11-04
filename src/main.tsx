import { I18nProvider, LanguageToolbar, useI18n } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { PlatformApp } from "./platform";
import { MerchantApp } from "./merchant";
import { Storefront } from "./storefront";
import { Join } from "./management";
import {
  ForgotPassword,
  ResetPassword,
  RecoveryListener,
} from "./account-recovery";
import "./style.css";
function AppRoutes() {
  const location = useLocation();
  if (location.pathname === "/") return <Navigate to={"/merchant" + location.search + location.hash} replace />;
  if (location.pathname === "/merchant") return <MerchantApp />;
  if (location.pathname === "/platform" || location.pathname.startsWith("/platform/")) return <PlatformApp />;
  return (
    <I18nProvider
      audience={
        location.pathname.startsWith("/shop/") ? "customer" : "merchant"
      }
    >
      <LanguageToolbar />
      <LocalizedRoutes />
    </I18nProvider>
  );
}
function LocalizedRoutes() {
  const { t } = useI18n();
  return (
    <>
      <Routes>
        <Route path="/join" element={<Join />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/shop/:slug" element={<Storefront />} />
        <Route path="/shop/:slug/product/:productId" element={<Storefront />} />
        <Route path="/shop/:slug/cart" element={<Storefront />} />
        <Route path="/shop/:slug/checkout" element={<Storefront />} />
        <Route path="/shop/:slug/order-result" element={<Storefront />} />
        <Route
          path="*"
          element={
            <div className="empty">
              <h1>{t("找不到页面")}</h1>
              <a href={import.meta.env.BASE_URL}>{t("返回 EZShop")}</a>
            </div>
          }
        />
      </Routes>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter
      basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}
    >
      <RecoveryListener />
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
