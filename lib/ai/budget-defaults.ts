// Defaults for a newly created AISettings row. They mirror the @default values on the
// AISettings model in prisma/schema.prisma, so a row gets the same budget whichever code
// path creates it. tests/ai-budget-defaults.test.ts fails if the two drift apart.
export const DEFAULT_MONTHLY_BUDGET_CENTS = 500;
export const DEFAULT_AUTOMATION_BUDGET_CENTS = 150;
export const DEFAULT_MAX_ANALYSES_PER_SYNC = 5;
