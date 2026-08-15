/** Drop entries older than ttlMs from a key→timestamp map (rate-limit bookkeeping). */
export function sweepExpired(map: Map<string, number>, now: number, ttlMs: number): void {
    for (const [key, ts] of map) {
        if (now - ts > ttlMs) map.delete(key);
    }
}
