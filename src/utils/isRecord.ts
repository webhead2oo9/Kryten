/**
 * Type guard for a plain parsed-JSON object (not null, not an array). The one
 * home for this check — it was previously re-implemented in five files.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
