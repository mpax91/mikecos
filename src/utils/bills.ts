/** "$19.50" for Auto-Pay bill markers on the Calendar (Bills & Due Dates). */
export const fmtBillMoney = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
