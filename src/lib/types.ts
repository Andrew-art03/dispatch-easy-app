export type LoadState =
  | "candidate_found"
  | "qualified"
  | "pursue_approved"
  | "negotiating"
  | "terms_proposed"
  | "rate_con_received"
  | "booked"
  | "in_transit"
  | "delivered"
  | "billing_ready"
  | "paid_reconciled"
  | "learned"
  | "rejected";

export type EquipmentType = "van" | "reefer" | "flatbed" | "stepdeck" | "hotshot" | "box" | "other";

export type DocumentType =
  | "rate_con"
  | "bol"
  | "pod"
  | "fuel_receipt"
  | "lumper_receipt"
  | "scale_ticket"
  | "inspection"
  | "other";

export type Verdict = "take" | "negotiate" | "skip";

export type Stop = {
  id: string;
  load_id: string;
  seq: number;
  type: "pickup" | "delivery";
  address: string;
  city: string | null;
  state: string | null;
  window_start: string | null;
  window_end: string | null;
};

export type Score = {
  id: string;
  load_id: string;
  calc_version: string;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  verdict: Verdict;
  true_net: number | null;
  all_in_rpm: number | null;
  net_per_day: number | null;
  recommended_bid: number | null;
  floor_rate: number | null;
  reasons: string[] | null;
  created_at: string | null;
};

export type Deal = {
  id: string;
  load_id: string;
  target_rate: number | null;
  floor_rate: number | null;
  agreed_rate: number | null;
  payment_terms: string | null;
  script: string | null;
};

export type Load = {
  id: string;
  reference: string | null;
  state: LoadState;
  source: string | null;
  equipment: EquipmentType | null;
  gross_rate: number | null;
  accessorials: number | null;
  loaded_miles: number | null;
  deadhead_miles: number | null;
  weight_lb: number | null;
  commodity: string | null;
  pickup_at: string | null;
  deliver_by: string | null;
  created_at: string | null;
};

export type LoadWithRelations = Load & {
  stop: Stop[] | null;
  score: Score[] | null;
  deal: Deal[] | null;
};

export type Truck = {
  id: string;
  org_id: string;
  unit_number: string;
  equipment: EquipmentType;
  mpg_loaded: number | null;
  mpg_empty: number | null;
  fuel_discount_per_gal: number | null;
  maintenance_reserve_per_mile: number | null;
  tire_reserve_per_mile: number | null;
  overhead_per_day: number | null;
  driver_pay_type: string | null;
  driver_pay_value: number | null;
  cpm_target: number | null;
  height_ft: number | null;
  length_ft: number | null;
  weight_lb: number | null;
  hazmat: boolean | null;
  max_deadhead_miles: number | null;
  banned_states: string[] | null;
  home_base_lat: number | null;
  home_base_lng: number | null;
};

export type DocumentRow = {
  id: string;
  load_id: string | null;
  type: DocumentType;
  storage_path: string;
  created_at: string | null;
};

export type LedgerLine = {
  id: string;
  load_id: string | null;
  category: string;
  amount: number;
  source: string | null;
  at: string | null;
  load?: { reference: string | null } | null;
};
