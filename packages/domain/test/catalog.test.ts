import { describe, expect, it } from "vitest";

import { CREDITS_PER_USD, CREDIT_PACKS, JOB_CREDIT_COSTS, publicCatalog } from "../src/index";

describe("credit catalog", () => {
  it("stores Paddle amounts as lowest-denomination strings", () => {
    expect(CREDIT_PACKS.map((pack) => pack.amount)).toEqual(["900", "1900", "3900"]);
  });

  it("models every pack as a one-time SaaS product", () => {
    for (const pack of CREDIT_PACKS) {
      expect(pack.billingType).toBe("one_time");
      expect(pack.taxCategory).toBe("saas");
    }
  });

  it("uses the USD 1 to 10 credit base rate and explicit pack bonuses", () => {
    expect(CREDITS_PER_USD).toBe(10);
    expect(CREDIT_PACKS.map((pack) => pack.creditGrant)).toEqual([90, 210, 450]);
    expect(CREDIT_PACKS.map((pack) => pack.completedTasks)).toEqual([3, 7, 15]);
    for (const pack of CREDIT_PACKS) {
      expect(pack.creditGrant % 30).toBe(0);
      expect(pack.completedTasks).toBe(pack.creditGrant / 30);
    }
  });

  it("publishes the approved job costs without a cash wallet", () => {
    expect(JOB_CREDIT_COSTS).toEqual({
      technical_self_check: 30,
      guided_search_fast: 30,
      guided_search_balanced: 30,
      guided_search_premium: 30,
    });
    expect(publicCatalog().terms.cash_value).toBe(false);
  });
});
