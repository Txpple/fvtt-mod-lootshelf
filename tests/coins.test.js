// The kernel's coin arithmetic (scripts/transfer.js): payment, the recorded change, and the
// revert's give-back. transfer.js registers hooks at import, so a stub Hooks stands in.
let t;

beforeAll(async () => {
  globalThis.Hooks = { on: () => {}, once: () => {} };
  t = await import("../scripts/transfer.js");
});

afterAll(() => {
  delete globalThis.Hooks;
});

const purse = (pp = 0, gp = 0, ep = 0, sp = 0, cp = 0) => ({ pp, gp, ep, sp, cp });

describe("paying", () => {
  it("spends small coins first and gives change in gp, sp and cp", () => {
    expect(t.planDeduction(purse(1, 0, 0, 0, 0), 250)).toEqual(purse(0, 7, 0, 5, 0));
    expect(t.planDeduction(purse(0, 3, 0, 4, 9), 49)).toEqual(purse(0, 3, 0, 0, 0));
  });

  it("refuses what the purse cannot afford", () => {
    expect(t.planDeduction(purse(0, 1), 101)).toBe(null);
  });
});

describe("the recorded change", () => {
  it("is signed per denomination, after minus before", () => {
    expect(t.purseDelta(purse(1, 0, 0, 0, 0), purse(0, 7, 0, 5, 0))).toEqual(purse(-1, 7, 0, 5, 0));
  });
});

describe("the revert's give-back", () => {
  it("restores a purchase's purse exactly when nothing has moved since", () => {
    const before = purse(1, 2, 0, 3, 4);
    const paid = t.planDeduction(before, 1234);
    const delta = t.purseDelta(before, paid);
    expect(t.reverseDelta(paid, delta)).toEqual(before);
  });

  it("gives back coins gained as themselves while the purse holds them", () => {
    expect(t.reverseDelta(purse(0, 12, 0, 0, 0), purse(0, 5))).toEqual(purse(0, 7));
  });

  it("converts only what the purse no longer holds, keeping the value exact", () => {
    const back = t.reverseDelta(purse(1, 0, 0, 0, 0), purse(0, 5));
    expect(back).toEqual(purse(0, 5, 0, 0, 0));
    expect(t.totalCopper(purse(1)) - t.totalCopper(back)).toBe(500);
  });

  it("returns coins lost as themselves", () => {
    expect(t.reverseDelta(purse(0, 1), purse(-2, 0, 0, -3))).toEqual(purse(2, 1, 0, 3, 0));
  });

  it("refuses when the purse can no longer cover what it gained", () => {
    expect(t.reverseDelta(purse(0, 2), purse(0, 5))).toBe(null);
  });

  it("reads a missing delta as no change", () => {
    expect(t.reverseDelta(purse(0, 3), undefined)).toEqual(purse(0, 3));
  });
});

describe("labels", () => {
  it("formats copper in gp, sp and cp, and an empty purse as no coin", () => {
    expect(t.formatCopper(1234)).toBe("12 gp 3 sp 4 cp");
    expect(t.formatCopper(0)).toBe("free");
    expect(t.formatPurse(0)).toBe("no coin");
  });
});
