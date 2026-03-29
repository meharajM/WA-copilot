/**
 * Shared WhatsApp identity helpers used by both main and renderer layers.
 * They normalize JIDs/phone strings to comparable digit-only identifiers.
 */

export function normalizeWhatsAppId(input?: string | null): string | null {
  if (!input || typeof input !== "string") return null;

  const withoutDomain = input.split("@")[0]?.split(":")[0] ?? "";
  const digits = withoutDomain.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function isSameWhatsAppIdentity(
  a?: string | null,
  b?: string | null
): boolean {
  const aId = normalizeWhatsAppId(a);
  const bId = normalizeWhatsAppId(b);

  if (!aId || !bId) return false;

  // Support legacy inputs where one side may contain missing country code segments.
  return aId === bId || aId.endsWith(bId) || bId.endsWith(aId);
}
