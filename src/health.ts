import { createServer, Server } from "http";
import { KrytenClient } from "./classes/client";
import { getCrosspostHandler, getImageFingerprintHandler } from "./handlers/messageHandler";
import { COMMANDS_READ_PATH, handleCommandRead } from "./api/commandRead";
import { handleProposalIntake } from "./api/proposalIntake";

export function startHealthServer(client: KrytenClient, port: number): Server {
    const server = createServer((req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (req.method === "POST" && url.pathname === "/api/v1/commands/proposals") {
                handleProposalIntake(client, req, res);
            } else if (
                req.method === "GET" &&
                (url.pathname === COMMANDS_READ_PATH || url.pathname.startsWith(`${COMMANDS_READ_PATH}/`))
            ) {
                handleCommandRead(client, req, res, url);
            } else if (req.method === "GET" && url.pathname === "/health") {
                const discordConnected = client.ws.status === 0;

                const connections: Record<string, object> = {
                    discord: {
                        status: discordConnected ? "connected" : "disconnected",
                        ...(discordConnected
                            ? { latency: client.ws.ping }
                            : { error: `WebSocket status: ${client.ws.status}` }),
                    },
                };

                const hasDisconnect = Object.values(connections).some((c: any) => c.status === "disconnected");

                const body = JSON.stringify({
                    name: client.name,
                    status: hasDisconnect ? "unhealthy" : "healthy",
                    uptime: Math.floor(process.uptime()),
                    version: client.version,
                    connections,
                    metrics: {
                        guilds: client.guilds.cache.size,
                        members: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
                        commandsHandled: client.commandsHandled,
                        customCommands: client.custom_commands.length,
                        crosspost: getCrosspostHandler(client).getMetrics(),
                        imageFingerprint: {
                            ...getImageFingerprintHandler(client).getMetrics(),
                            corpusSize: getImageFingerprintHandler(client).store.size,
                            hubActive: getImageFingerprintHandler(client).store.hubActive,
                        },
                    },
                    errors: {
                        recent: client.errorCount,
                        last: client.lastErrorTime,
                    },
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(body);
            } else {
                res.writeHead(404);
                res.end();
            }
        } catch (error) {
            console.error("Health endpoint request failed:", error);
            void client
                .logError("Health endpoint request failed", error instanceof Error ? error : String(error))
                .catch(() => undefined);
            if (!res.headersSent && !res.writableEnded) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "error", message: "health endpoint failed" }));
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    });

    // Without a listener, an async listen error (e.g. EADDRINUSE from a
    // not-yet-dead previous instance) is an uncaught exception that kills the
    // whole bot. The health endpoint is auxiliary — log and carry on.
    server.on("error", error => {
        console.error(`Health endpoint failed on port ${port}:`, error);
    });

    // Bind to loopback by default: /health is unauthenticated (leaks guild /
    // member counts, version, error + corpus state) and the same server hosts
    // the corpus-mutating proposal intake. On a shared host neither should be
    // reachable from other tenants. Set HEALTH_HOST (e.g. 0.0.0.0) to expose it
    // deliberately, behind a trusted proxy.
    const host = process.env["HEALTH_HOST"] || "127.0.0.1";
    server.listen(port, host, () => {
        console.log(`Health endpoint listening on ${host}:${port}`);
    });

    return server;
}
