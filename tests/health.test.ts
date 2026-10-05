import { afterEach, describe, expect, it, vi } from "vitest";
import { Status } from "discord.js";
import type { AddressInfo } from "node:net";
import type { KrytenClient } from "../src/classes/client";

const H = vi.hoisted(() => ({
    shadowMetrics: {
        since: "process_start",
        tasks: {
            beta_routing: { compared: 2, matches: 1, mismatches: 1, matchPercent: 50 },
            beta_greeting: { compared: 0, matches: 0, mismatches: 0, matchPercent: null },
        },
    },
}));

vi.mock("../src/handlers/messageHandler", () => ({
    getCrosspostHandler: () => ({ getMetrics: () => ({}) }),
    getImageFingerprintHandler: () => ({ getMetrics: () => ({}), store: { size: 0, hubActive: false } }),
    getLlmClassifier: () => ({ getMetrics: () => ({}) }),
    getClassificationLogger: () => ({ getMetrics: () => ({}) }),
    getBetaClassifier: () => ({ getMetrics: () => ({}) }),
    getBetaResponder: () => ({ getMetrics: () => ({}) }),
    getTypeSafeShadowService: () => ({ getMetrics: () => H.shadowMetrics }),
}));

import { startHealthServer } from "../src/health";

describe("health TypeSafe shadow metrics", () => {
    const servers: ReturnType<typeof startHealthServer>[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    });

    it("exposes process-start agreement counters including a zero-denominator task", async () => {
        const client = {
            name: "Kryten",
            version: "test",
            ws: { status: Status.Ready, ping: 1 },
            guilds: { cache: { size: 0, reduce: () => 0 } },
            commandsHandled: 0,
            custom_commands: [],
            errorCount: 0,
            lastErrorTime: null,
            logError: vi.fn(async () => undefined),
        } as unknown as KrytenClient;
        const server = startHealthServer(client, 0);
        servers.push(server);
        await new Promise<void>(resolve => server.once("listening", resolve));
        const port = (server.address() as AddressInfo).port;

        const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as any;

        expect(body.metrics.typeSafeShadow).toEqual(H.shadowMetrics);
        expect(body.metrics.typeSafeShadow.tasks.beta_greeting.matchPercent).toBeNull();
    });
});
