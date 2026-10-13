// Linear-programming bounds for the Hard solver: the exact minimum and maximum
// of each variable over the polytope { x : every row holds, lo ≤ x ≤ hi }.
// Bounded-variable primal simplex with Bland's rule (these 0/1 systems are
// highly degenerate, and Bland's rule can't cycle).

export interface LinearRow {
  vars: number[];
  coefs: number[];
  rhs: number;
}

const EPS = 1e-9;
const MAX_ITERATIONS = 100_000;

// Returns null if the system has no solution.
export function variableRanges(
  nVars: number,
  rows: LinearRow[],
  lo: Float64Array,
  hi: Float64Array,
): { min: Float64Array; max: Float64Array } | null {
  // Shift to y = x − lo ∈ [0, hi − lo], and give each row an artificial
  // variable so the all-artificial basis is feasible.
  const m = rows.length;
  const n = nVars + m;
  const T = new Float64Array(m * n); // B⁻¹A
  const upper = new Float64Array(n);
  const val = new Float64Array(n);
  const atUpper = new Uint8Array(n);
  const basis = new Int32Array(m);
  const basicRow = new Int32Array(n).fill(-1);
  for (let j = 0; j < nVars; j++) upper[j] = hi[j] - lo[j];
  for (let i = 0; i < m; i++) {
    const { vars, coefs } = rows[i];
    let rhs = rows[i].rhs;
    for (let q = 0; q < vars.length; q++) rhs -= coefs[q] * lo[vars[q]];
    const sign = rhs < 0 ? -1 : 1;
    for (let q = 0; q < vars.length; q++) T[i * n + vars[q]] += sign * coefs[q];
    const a = nVars + i;
    T[i * n + a] = 1;
    upper[a] = Infinity;
    val[a] = sign * rhs;
    basis[i] = a;
    basicRow[a] = i;
  }

  const pivot = (r: number, e: number): void => {
    const row = r * n;
    const p = T[row + e];
    for (let k = 0; k < n; k++) T[row + k] /= p;
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const f = T[i * n + e];
      if (f === 0) continue;
      const other = i * n;
      for (let k = 0; k < n; k++) T[other + k] -= f * T[row + k];
      T[other + e] = 0;
    }
    basicRow[basis[r]] = -1;
    basis[r] = e;
    basicRow[e] = r;
  };

  // Minimizes Σ cost·y from the current feasible basis.
  const reduced = new Float64Array(n);
  const optimize = (cost: Float64Array): void => {
    for (let iter = 0; ; iter++) {
      if (iter > MAX_ITERATIONS) throw new Error("simplex did not converge");
      reduced.set(cost);
      for (let i = 0; i < m; i++) {
        const cb = cost[basis[i]];
        if (cb === 0) continue;
        const row = i * n;
        for (let k = 0; k < n; k++) reduced[k] -= cb * T[row + k];
      }
      // Bland: lowest-index improving nonbasic variable enters.
      let e = -1;
      for (let j = 0; j < n; j++) {
        if (basicRow[j] >= 0 || upper[j] < EPS) continue;
        if (atUpper[j] ? reduced[j] > EPS : reduced[j] < -EPS) {
          e = j;
          break;
        }
      }
      if (e < 0) return;
      const dir = atUpper[e] ? -1 : 1;

      // Ratio test: how far e can move before it or a basic variable hits a bound.
      let theta = upper[e];
      let leave = -1;
      for (let i = 0; i < m; i++) {
        const rate = -T[i * n + e] * dir;
        const b = basis[i];
        let limit: number;
        if (rate < -EPS) limit = val[b] / -rate;
        else if (rate > EPS) limit = (upper[b] - val[b]) / rate;
        else continue;
        // Strictly tighter wins; on a tie, Bland picks the lowest basic index
        // (and a tie with e's own bound flip keeps the flip).
        if (limit < theta - EPS) {
          theta = Math.max(limit, 0);
          leave = i;
        } else if (limit <= theta + EPS && leave >= 0 && b < basis[leave]) {
          leave = i;
        }
      }
      if (theta === Infinity) throw new Error("simplex: unbounded direction");

      for (let i = 0; i < m; i++) val[basis[i]] -= T[i * n + e] * dir * theta;
      val[e] += dir * theta;
      if (leave < 0) {
        atUpper[e] = dir > 0 ? 1 : 0;
        val[e] = atUpper[e] ? upper[e] : 0;
        continue;
      }
      const b = basis[leave];
      const rate = -T[leave * n + e] * dir;
      atUpper[b] = rate > 0 ? 1 : 0;
      val[b] = atUpper[b] ? upper[b] : 0;
      atUpper[e] = 0;
      pivot(leave, e);
    }
  };

  // Phase 1: drive the artificials to zero, then pin them there.
  const cost = new Float64Array(n);
  for (let i = 0; i < m; i++) cost[nVars + i] = 1;
  optimize(cost);
  for (let i = 0; i < m; i++) {
    if (val[nVars + i] > 1e-7) return null;
    upper[nVars + i] = 0;
    val[nVars + i] = 0;
  }

  // Phase 2: optimize each variable in each direction, skipping any bound
  // already attained by a solution seen along the way.
  const min = new Float64Array(nVars).fill(Infinity);
  const max = new Float64Array(nVars).fill(-Infinity);
  const observe = (): void => {
    for (let j = 0; j < nVars; j++) {
      const x = lo[j] + val[j];
      if (x < min[j]) min[j] = x;
      if (x > max[j]) max[j] = x;
    }
  };
  observe();
  cost.fill(0);
  for (let j = 0; j < nVars; j++) {
    for (const sense of [1, -1]) {
      if (sense > 0 ? min[j] <= lo[j] + 1e-7 : max[j] >= hi[j] - 1e-7) continue;
      cost[j] = sense;
      optimize(cost);
      cost[j] = 0;
      observe();
    }
  }
  return { min, max };
}
