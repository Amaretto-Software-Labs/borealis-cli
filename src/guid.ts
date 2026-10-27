// API identities are nonempty .NET Guid values. Hash-derived identities do not
// necessarily carry an RFC UUID version or variant, but their full bits still bind
// the exact VM, request and operation; never compare only a portion of the value.
const canonicalGuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    canonicalGuid.test(value) &&
    value.toLowerCase() !== "00000000-0000-0000-0000-000000000000"
  );
}

export function sameGuid(left: unknown, right: unknown): boolean {
  return (
    isGuid(left) && isGuid(right) && left.toLowerCase() === right.toLowerCase()
  );
}
