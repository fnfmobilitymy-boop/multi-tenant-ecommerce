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
export const COURIERS = [
  "J&T Express",
  "Pos Laju",
  "DHL eCommerce",
  "Ninja Van",
  "Flash Express",
  "City-Link Express",
  "GDEX",
  "SPX Express",
];
export interface ShippingQuote {
  subtotal: number;
  shipping: number | null;
  destination_required?: boolean;
  discount: number;
  total: number | null;
}
