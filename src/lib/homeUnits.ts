// Shared feet/inches <-> whole-inches conversion for the Home floor plan.
// Everything in the Home data model (room width/depth, fixture footprint,
// canvas position) is stored in whole inches server-side — see
// worker/migrations/0077_home.sql — so the canvas is literally to-scale.
// The UI always lets Mike type feet and inches separately (rather than a
// single "150" field) since that's how he'll actually have the numbers
// from a tape measure or a furniture listing.

export function feetInchesToInches(feet: number | string, inches: number | string): number {
  const f = Number(feet) || 0;
  const i = Number(inches) || 0;
  return Math.round(f * 12 + i);
}

/** e.g. 150 -> "12'6\"", 144 -> "12'0\"", 6 -> "0'6\"" */
export function formatFeetInches(totalInches: number): string {
  const sign = totalInches < 0 ? '-' : '';
  const abs = Math.abs(Math.round(totalInches));
  const feet = Math.floor(abs / 12);
  const inches = abs % 12;
  return `${sign}${feet}'${inches}"`;
}

export function inchesToFeet(totalInches: number): number {
  return Math.floor(Math.abs(totalInches) / 12);
}

export function inchesRemainder(totalInches: number): number {
  return Math.abs(Math.round(totalInches)) % 12;
}
