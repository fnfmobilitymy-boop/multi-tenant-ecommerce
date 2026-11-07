import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import platformIcon from "./assets/platform-icon.jpg";
import merchantIcon from "./assets/merchant-icon.jpg";
import customerIcon from "./assets/customer-icon.jpg";

export function portalIcon(pathname: string) {
  if (pathname === "/platform" || pathname.startsWith("/platform/")) return platformIcon;
  if (pathname.startsWith("/shop/")) return customerIcon;
  return merchantIcon;
}

export function PortalFavicon() {
  const { pathname } = useLocation();
  const icon = portalIcon(pathname);
  useEffect(() => {
    let link = document.head.querySelector<HTMLLinkElement>('link[data-ezshop-icon]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.dataset.ezshopIcon = "true";
      document.head.appendChild(link);
    }
    link.type = "image/jpeg";
    link.href = icon;
  }, [icon]);
  return null;
}
