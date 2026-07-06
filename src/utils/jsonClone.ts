/**
 * Deep-clone plain parsed-JSON values. The single snapshot-before-mutate
 * primitive for command bodies and editor sessions — if command payloads
 * ever carry non-JSON values, this is the one place to swap the strategy.
 */
export function jsonClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
