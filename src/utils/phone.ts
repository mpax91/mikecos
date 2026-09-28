/** Shared by the Details/facts row renderers in WalletBarcodeView.tsx and
 * PaymentCardDetail.tsx (Mike's request: a "Phone #" detail should be a
 * tappable tel: link, on mobile and desktop alike, not just inert text).
 * Facts have a free-text label (no enum — see wallet.ts/paymentCards.ts's
 * factJson), so this is a loose match on the label rather than a fixed
 * key: "Phone #", "Phone", "Customer Service Phone", "Lost/Stolen Phone"
 * all count. */
export function isPhoneLabel(label: string): boolean {
  return /phone/i.test(label);
}

/** A tel: URI needs digits (and a leading +) only — this strips
 * formatting (dashes, parens, spaces, "ext." notes) down to something a
 * phone dialer can actually place a call to. Returns null when there
 * aren't enough digits left to plausibly be a phone number, so a stray
 * "Phone" label on a non-numeric value never renders a dead link. */
export function telHref(value: string): string | null {
  const plus = value.trim().startsWith('+') ? '+' : '';
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return `tel:${plus}${digits}`;
}
