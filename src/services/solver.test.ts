import { afterEach, describe, expect, it, vi } from "vitest";
import { SODAX_SOLVER_BASE_URL } from "../constants.js";
import { clearSolverCache, getSolverOracle } from "./solver.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearSolverCache();
});

describe("getSolverOracle", () => {
  it("reads this env's oracle by default, and caches each host's apart", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url => Response.json([{ url: String(url) }]));
    const other = "https://oracle.example/v1/intent";
    expect(await getSolverOracle()).toEqual([{ url: `${SODAX_SOLVER_BASE_URL}/oracle` }]);
    expect(await getSolverOracle(other)).toEqual([{ url: `${other}/oracle` }]);
    await getSolverOracle();
    await getSolverOracle(other);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
