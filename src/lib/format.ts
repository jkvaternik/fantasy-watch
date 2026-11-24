/** Probability as a percentage, without rounding a live race to a dead certainty. */
export const pct = (p: number) => {
  if (p >= 0.9995) return "100%";
  if (p <= 0) return "0%";
  if (p < 0.001) return "<0.1%";
  return `${(p * 100).toFixed(p < 0.0495 ? 1 : 0)}%`;
};
