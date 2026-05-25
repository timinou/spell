// PLAN-318 W1 edge dispatch test fixture.
// `compute` is called by `main`. A def→ query against `compute` should
// surface `main` as a referrer.

export function compute(x: number): number {
  return x * 2;
}

export function main(): number {
  const a = compute(3);
  const b = compute(5);
  return a + b;
}
