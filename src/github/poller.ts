/**
 * Background poller: periodically compares the commands repo's directory
 * digest (listing only — no file contents) against the digest of the last
 * successful load, and hot-reloads + re-registers when it changes. This is
 * what lets external edits (LLM proposals, direct commits, PR merges) go
 * live without anyone running /reload_commands.
 */
import type { KrytenClient } from "../classes/client";

const DEFAULT_POLL_MINUTES = 60;

export class CommandPoller {
    private timer?: NodeJS.Timeout;
    private checking = false;
    /** Edge-trigger for repo-unreachable alerting (alert once per outage, not per tick). */
    private lastTickFailed = false;
    /**
     * Set when a reload succeeded but re-registering slash commands with Discord
     * failed. The corpus is already current in memory (and the fresh digest is
     * adopted), so a plain re-poll finds no change and registerIfChanged — which
     * diffs before/after — would never re-fire. Retry unconditionally each tick
     * until it lands, so a transient Discord 5xx doesn't leave the rename/desc
     * change missing from Discord until an unrelated later commit.
     */
    private registrationPending = false;

    constructor(private readonly client: KrytenClient) {}

    private intervalMs(): number {
        const minutes = this.client.config.githubPollMinutes ?? DEFAULT_POLL_MINUTES;
        // Node clamps setInterval delays above 2^31-1 ms down to 1 ms (firing in
        // a tight loop). Cap so an absurd githubPollMinutes can't turn the poller
        // into a GitHub-hammering busy loop.
        return minutes > 0 ? Math.min(minutes * 60_000, 2_147_483_647) : 0;
    }

    start(): void {
        this.stop();
        const interval = this.intervalMs();
        if (interval <= 0) {
            console.log("Command poller disabled (githubPollMinutes <= 0)");
            return;
        }
        if (!this.client.commandSync.filesClient()) {
            console.log("Command poller disabled (GitHub commands repo not configured)");
            return;
        }
        this.timer = setInterval(() => void this.checkNow(), interval);
        this.timer.unref();
        console.log(`Command poller started (every ${interval / 60_000} min)`);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * Wire an out-of-band registration failure (the startup register after a
     * successful load) into the same per-tick retry as a failed reload
     * registration: the digest is already adopted in both cases, so a plain
     * re-poll would see "no change" and never re-push to Discord.
     */
    markRegistrationPending(): void {
        this.registrationPending = true;
    }

    /** Re-push the full command set to Discord after a prior registration failure. */
    private async retryRegistration(): Promise<void> {
        try {
            await this.client.registerApplicationCommands();
            this.registrationPending = false;
            console.log("Pending slash-command registration retried successfully.");
        } catch (error) {
            console.error("Slash-command registration retry failed; will retry next poll:", error);
        }
    }

    /** One poll cycle; safe to call directly (used by /reload-adjacent flows and tests). */
    async checkNow(): Promise<void> {
        if (this.checking) return;
        this.checking = true;
        try {
            const files = this.client.commandSync.filesClient();
            if (!files) return;

            // A prior tick loaded a change but couldn't push it to Discord. The
            // corpus is already current, so registerIfChanged sees no diff — force
            // an unconditional re-registration before the normal digest check.
            if (this.registrationPending) await this.retryRegistration();

            const remoteDigest = await files.fetchRemoteDigest();
            if (!remoteDigest) {
                // Alert once when the repo becomes unreachable — a silently dead
                // poller means external edits never go live and nobody notices.
                if (!this.lastTickFailed) {
                    await this.client
                        .logError(
                            "Command Poller Cannot Reach Repo",
                            "The commands-repo listing failed; polling for external edits is paused until it recovers.",
                        )
                        .catch(() => undefined);
                }
                this.lastTickFailed = true;
                return; // next tick retries
            }
            this.lastTickFailed = false;

            const currentDigest = this.client.commandSync.getDigest();
            // Normally we reload only when the listing digest changes. But if the
            // last load fell back to the local snapshot (GitHub unreachable at
            // boot/reload), the digest can already equal the remote one while the
            // corpus is still running from cache — proposals stay disabled and
            // rawBodies aren't byte-faithful, with no operator signal. Now that the
            // listing is reachable again, force one real load to leave the fallback.
            // Self-limiting: a successful load flips lastLoadSource to "github".
            const onFallback = this.client.commandSync.lastLoadSource !== "github";
            if (currentDigest === remoteDigest && !onFallback) return;

            console.log(
                onFallback && currentDigest === remoteDigest
                    ? "Commands repo reachable again; reloading to leave the local-snapshot fallback"
                    : `Command repo changed (digest ${currentDigest?.slice(0, 12) ?? "unknown"} → ${remoteDigest.slice(0, 12)}…); reloading`,
            );
            const previous = this.client.custom_commands;
            await this.client.commandSync.loadAll();

            // Only treat the change as consumed when the reload actually
            // caught up to what we polled; otherwise the stale digest makes
            // the next tick retry.
            if (this.client.commandSync.lastLoadSource !== "github") {
                console.warn("Command reload after repo change fell back to the local snapshot; will retry next poll");
                return;
            }

            try {
                const reRegistered = await this.client.registerIfChanged(previous);
                // Only clear the pending flag when a registration actually reached
                // Discord. registerIfChanged returns false (no set() call) on a
                // content-only reload, so an unconditional clear here would abandon
                // a still-unpushed (name/description) change left by an earlier
                // failed tick — the retry at the top of checkNow handles that case.
                if (reRegistered) this.registrationPending = false;
                console.log(
                    reRegistered
                        ? "Command reload complete; slash commands re-registered"
                        : "Command reload complete; registration unchanged",
                );
            } catch (error) {
                // The corpus loaded fine but Discord registration failed. Mark it
                // pending so the next tick retries, instead of treating the polled
                // change as consumed (the digest was already adopted by loadAll).
                this.registrationPending = true;
                console.error(
                    "Reload registered the corpus but slash registration failed; will retry next poll:",
                    error,
                );
                await this.client
                    .logError("Command Registration Retry Pending", error instanceof Error ? error : String(error))
                    .catch(() => undefined);
            }
        } catch (error) {
            console.error("Command poller cycle failed:", error);
            await this.client
                .logError("Command Poller Failed", error instanceof Error ? error : String(error))
                .catch(() => undefined);
        } finally {
            this.checking = false;
        }
    }
}
