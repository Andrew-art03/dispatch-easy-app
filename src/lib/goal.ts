/** Week Pay Tracker mock figures — visual only, shared across screens. */
export const WEEK_GOAL = {
  target: 6000,
  earned: 3400,
  weekLabel: "Week of Sep 1",
};

export function money(value: number) {
  return `$${value.toLocaleString()}`;
}

export function moneyShort(value: number) {
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value}`;
}
