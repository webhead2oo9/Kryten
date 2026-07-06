/**
 * Thin typed client for the FingerprintHub `/v1` API (see the FingerprintHub
 * repo's docs/API.md). It mirrors the transport discipline of the rest of the
 * bot: every method returns a structured result and never throws — the hub is
 * off the moderation hot path, so a hub outage must degrade silently, never
 * take down a feature.
 *
 * Auth is a per-consumer `fph_…` key in `X-API-Key`. We only ever talk to the
 * hub from background tasks (sync loop, fire-and-forget contribute/hit/flag).
 */

export const DEFAULT_HUB_BASE_URL = "http://127.0.0.1:58751";

/** A row as returned by GET /v1/fingerprints/sync (secrets + stats omitted). */
export interface HubSyncRow {
    id: number;
    sync_seq: number;
    phash_hex: string;
    algorithm: string;
    algorithm_version: string;
    normalization_version: string;
    category: string;
    action: string;
    consumer_id: number;
    status: "active" | "hidden" | "deleted";
    auto_added?: boolean;
    provenance?: string;
    source_guild_id?: string | null;
    added_at_ms?: number;
    updated_at_ms?: number;
}

export interface HubSyncPage {
    fingerprints: HubSyncRow[];
    next_since: number;
    has_more: boolean;
}

export interface HubContributePayload {
    phash_hex: string;
    category: string;
    action: string;
    algorithm: string;
    algorithm_version: string;
    normalization_version: string;
    auto_added?: boolean;
    provenance?: string;
    source_url?: string;
    reason?: string;
    source_guild_id?: string;
}

/** Result of a contribute: linked (created or pre-existing) or failed. */
export type ContributeResult = { status: "linked"; hubId: number } | { status: "error"; detail: string };

export class FingerprintHubClient {
    private readonly baseUrl: string;

    constructor(
        baseUrl: string,
        private readonly apiKey: string,
        private readonly timeoutMs: number = 5000,
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{ ok: true; status: number; json: unknown } | { ok: false; detail: string }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    "X-API-Key": this.apiKey,
                    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            let json: unknown = null;
            // 204 (delete) and empty bodies have nothing to parse.
            if (res.status !== 204) json = await res.json().catch(() => null);
            return { ok: true, status: res.status, json };
        } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        } finally {
            clearTimeout(timer);
        }
    }

    /** Incremental pull. Returns null on any transport/HTTP failure. */
    async sync(params: {
        since: number;
        limit: number;
        algorithm: string;
        algorithm_version: string;
        normalization_version: string;
    }): Promise<HubSyncPage | null> {
        const qs = new URLSearchParams({
            since: String(params.since),
            limit: String(params.limit),
            algorithm: params.algorithm,
            algorithm_version: params.algorithm_version,
            normalization_version: params.normalization_version,
        });
        const res = await this.request("GET", `/v1/fingerprints/sync?${qs.toString()}`);
        if (!res.ok || res.status !== 200 || res.json === null) return null;
        const page = res.json as Partial<HubSyncPage>;
        if (!Array.isArray(page.fingerprints)) return null;
        return {
            fingerprints: page.fingerprints,
            next_since: typeof page.next_since === "number" ? page.next_since : params.since,
            has_more: Boolean(page.has_more),
        };
    }

    /** Contribute a fingerprint. 200/201→created, 409→already exists (both "linked"). */
    async contribute(payload: HubContributePayload): Promise<ContributeResult> {
        const res = await this.request("POST", "/v1/fingerprints", payload);
        if (!res.ok) return { status: "error", detail: res.detail };
        if (res.status === 200 || res.status === 201) {
            const id = (res.json as { id?: number } | null)?.id;
            if (typeof id === "number") return { status: "linked", hubId: id };
            return { status: "error", detail: `missing id in ${res.status} response` };
        }
        if (res.status === 409) {
            const existing = (res.json as { existing_id?: number } | null)?.existing_id;
            if (typeof existing === "number") return { status: "linked", hubId: existing };
            return { status: "error", detail: "409 without existing_id" };
        }
        return { status: "error", detail: `HTTP ${res.status}` };
    }

    /** Fire-and-forget hit report; hub returns 200 or 404 (deleted). */
    async reportHit(hubId: number, opts: { guild_id?: string; distance?: number }): Promise<void> {
        const body: Record<string, unknown> = {};
        if (opts.guild_id) body["guild_id"] = opts.guild_id;
        if (opts.distance !== undefined) body["distance"] = opts.distance;
        await this.request("POST", `/v1/fingerprints/${hubId}/hit`, body);
    }

    /** Flag someone else's fingerprint (idempotent per consumer). */
    async flag(hubId: number, reason?: string): Promise<void> {
        await this.request("POST", `/v1/fingerprints/${hubId}/flag`, reason ? { reason } : {});
    }

    /** Soft-delete our own fingerprint. */
    async remove(hubId: number): Promise<void> {
        await this.request("DELETE", `/v1/fingerprints/${hubId}`);
    }
}
