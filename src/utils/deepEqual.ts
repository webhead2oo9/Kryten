/**
 * Structural equality for plain JSON values (objects, arrays, primitives).
 * Key order does not matter for objects; array order does. Used by the editor
 * save diff and by proposal patch guards — both compare parsed JSON only.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;

    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => deepEqual(item, b[i]));
    }
    if (typeof a === "object") {
        if (typeof b !== "object" || Array.isArray(b)) return false;
        const aKeys = Object.keys(a as object).filter(k => (a as Record<string, unknown>)[k] !== undefined);
        const bKeys = Object.keys(b as object).filter(k => (b as Record<string, unknown>)[k] !== undefined);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every(key => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
    }
    return false;
}
