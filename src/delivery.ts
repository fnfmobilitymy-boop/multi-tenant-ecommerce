import type { CountryCode } from "./commerce-currency";
export const MALAYSIA_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Kuala Lumpur",
  "Labuan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Penang",
  "Perak",
  "Perlis",
  "Putrajaya",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
];
// Suggestions only: merchants choose the service and verify coverage for their address.
export const COURIERS_BY_COUNTRY: Record<CountryCode, readonly string[]> = {
  MY: [
    "J&T Express",
    "Pos Laju",
    "DHL eCommerce",
    "Ninja Van",
    "Flash Express",
    "City-Link Express",
    "GDEX",
    "SPX Express",
    "Lalamove",
    "GrabExpress",
  ],
  SG: [
    "SingPost",
    "Speedpost",
    "Ninja Van",
    "J&T Express",
    "DHL Express",
    "Lalamove",
    "GrabExpress",
  ],
  TH: [
    "Thailand Post",
    "KEX Express",
    "Flash Express",
    "J&T Express",
    "DHL Express",
    "Lalamove",
    "GrabExpress",
  ],
  KH: [
    "Cambodia Post",
    "J&T Express",
    "VET Express",
    "DHL Express",
  ],
  VN: [
    "Vietnam Post",
    "Viettel Post",
    "GHN",
    "GHTK",
    "J&T Express",
    "SPX Express",
    "Lalamove",
    "GrabExpress",
  ],
};
export function couriersFor(country: CountryCode = "MY") {
  return COURIERS_BY_COUNTRY[country] || [];
}
export interface ShippingQuote {
  subtotal: number;
  shipping: number | null;
  destination_required?: boolean;
  discount: number;
  total: number | null;
}
