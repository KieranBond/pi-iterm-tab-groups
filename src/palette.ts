/**
 * Fixed accessible color palette for tab groups.
 * Stable deterministic color from immutable group ID.
 */

import * as crypto from "crypto";

/**
 * Fixed palette of accessible colors (WCAG AA compliant on dark backgrounds).
 * Colors are sufficiently distinct and avoid red/green confusion.
 */
const PALETTE: string[] = [
  "5B9BD5", // Blue
  "70AD47", // Green
  "FFC000", // Orange
  "C55A11", // Burnt Orange
  "7030A0", // Purple
  "44546A", // Dark Blue Gray
  "ED7D31", // Orange Red
  "A5A5A5", // Gray
  "4472C4", // Blue 2
  "548235", // Green 2
  "C65911", // Dark Orange
  "255E91", // Dark Blue
  "9E480E", // Brown
  "636363", // Dark Gray
  "997300", // Olive
  "264478", // Navy
];

/**
 * Generate a deterministic color from a group ID.
 * Uses SHA-256 hash to select from fixed palette.
 */
export function getGroupColor(groupId: string): string {
  const hash = crypto.createHash("sha256").update(groupId).digest();
  const index = hash[0] % PALETTE.length;
  return PALETTE[index];
}

/**
 * Generate a deterministic group ID from a label.
 * Format: label-{hash}
 */
export function normalizeGroupLabel(label: string): string {
  return label
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 48);
}

export function generateGroupId(label: string): string {
  const canonical = normalizeGroupLabel(label).toLowerCase();
  if (!canonical) throw new Error("Group label must not be empty");
  const slug = canonical.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "group";
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").substring(0, 8);
  return `${slug}-${hash}`;
}

/**
 * Validate that a color is in the approved palette.
 */
export function isValidPaletteColor(color: string): boolean {
  return PALETTE.includes(color);
}

/**
 * Get the full palette for testing/inspection.
 */
export function getPalette(): readonly string[] {
  return PALETTE;
}
