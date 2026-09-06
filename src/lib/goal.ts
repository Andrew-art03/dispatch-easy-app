/** Week Pay Tracker mock figures — visual only, shared across screens. */
export const WEEK_GOAL = {
  target: 6000,
  earned: 5400,
  weekLabel: "Week of Sep 1",
};

export const WEEK_DAY_EARNINGS = [
  { day: "Mon", amount: 500 },
  { day: "Tue", amount: 1200 },
  { day: "Wed", amount: 700 },
  { day: "Thu", amount: 1000 },
  { day: "Fri", amount: 2000 },
  { day: "Sat", amount: null },
  { day: "Sun", amount: null },
] as const;

export function money(value: number) {
  return `$${value.toLocaleString()}`;
}

export function moneyShort(value: number) {
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value}`;
}
