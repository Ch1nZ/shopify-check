import type { JobKind } from "@mclab/contracts";

export * from "./controlled-shopping";
export * from "./adaptive-shopping";
export * from "./public-offer";

export const PRICING_VERSION = "2026-09-beta-v2";

export const CREDITS_PER_USD = 10;

export type CreditPack = {
  key: "starter" | "builder" | "studio";
  productName: string;
  description: string;
  currencyCode: "USD";
  amount: string;
  creditGrant: number;
  completedTasks: number;
  taxCategory: "saas";
  billingType: "one_time";
  pricingVersion: typeof PRICING_VERSION;
};

export const CREDIT_PACKS: readonly CreditPack[] = [
  {
    key: "starter",
    productName: "MC Lab — Starter Credits",
    description:
      "90 credits for three completed Product Candidate-Set Diagnostics.",
    currencyCode: "USD",
    amount: "900",
    creditGrant: 90,
    completedTasks: 3,
    taxCategory: "saas",
    billingType: "one_time",
    pricingVersion: PRICING_VERSION,
  },
  {
    key: "builder",
    productName: "MC Lab — Builder Credits",
    description:
      "210 credits for seven completed Product Candidate-Set Diagnostics, including 20 bonus credits.",
    currencyCode: "USD",
    amount: "1900",
    creditGrant: 210,
    completedTasks: 7,
    taxCategory: "saas",
    billingType: "one_time",
    pricingVersion: PRICING_VERSION,
  },
  {
    key: "studio",
    productName: "MC Lab — Studio Credits",
    description:
      "450 credits for fifteen completed Product Candidate-Set Diagnostics, including 60 bonus credits.",
    currencyCode: "USD",
    amount: "3900",
    creditGrant: 450,
    completedTasks: 15,
    taxCategory: "saas",
    billingType: "one_time",
    pricingVersion: PRICING_VERSION,
  },
] as const;

export const JOB_CREDIT_COSTS = {
  technical_self_check: 30,
  guided_search_fast: 30,
  guided_search_balanced: 30,
  guided_search_premium: 30,
} as const satisfies Record<JobKind, number>;

export function creditCostFor(jobKind: JobKind): number {
  return JOB_CREDIT_COSTS[jobKind];
}

export function publicCatalog() {
  return {
    pricing_version: PRICING_VERSION,
    packs: CREDIT_PACKS.map((pack) => ({
      key: pack.key,
      name: pack.productName,
      currency_code: pack.currencyCode,
      amount: pack.amount,
      credits: pack.creditGrant,
      completed_diagnostics: pack.completedTasks,
      billing_type: pack.billingType,
    })),
    job_credit_costs: JOB_CREDIT_COSTS,
    terms: {
      transferable: false,
      cash_value: false,
      withdrawable: false,
      base_exchange_rate: "USD 1 = 10 credits",
      billing_unit: "one completed task",
      credits_per_completed_task: 30,
      failed_tasks_charged: false,
    },
  };
}
