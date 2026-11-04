import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { MerchantApp } from "./merchant";
import { Storefront } from "./storefront";
import { Join } from "./management";
import {
  ForgotPassword,
  ResetPassword,
  RecoveryListener,
} from "./account-recovery";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter
      basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}
    >
      <RecoveryListener />
      <Routes>
        <Route path="/" element={<MerchantApp />} />
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
              <h1>找不到页面</h1>
              <a href={import.meta.env.BASE_URL}>返回 EZShop</a>
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
