import { Colors, EmbedBuilder, type Message } from "discord.js";
import type { KrytenClient } from "../classes/client";
import { authorized, type ClassificationResult, type ClassificationStatus } from "./classifier";
import { sanitizeSensitiveText } from "./privacy";

export interface ClassificationLoggerMetrics {
    sent: number;
    failures: number;
}

export interface ClassificationLogOptions {
    includeRawOutput?: boolean;
}

const STATUS_NAMES: Record<ClassificationStatus, string> = {
    ok: "OK",
    disabled: "Disabled",
    invalid_request: "Invalid request",
    missing_api_key: "Missing API key",
    queue_full: "Queue full",
    rate_limited: "Rate limited",
    stale: "Stale",
    timeout: "Timeout",
    http_error: "HTTP error",
    invalid_response: "Invalid response",
    invalid_label: "Invalid label",
};

export class ClassificationLogger {
    private sent = 0;
    private failures = 0;

    constructor(private readonly client: KrytenClient) {}

    getMetrics(): ClassificationLoggerMetrics {
        return { sent: this.sent, failures: this.failures };
    }

    async log<Label extends string>(
        message: Message,
        result: ClassificationResult<Label>,
        isAuthorized: () => boolean = () => true,
        options: ClassificationLogOptions = {},
    ): Promise<void> {
        const config = this.client.config.llm_classifier;
        const channelId = config?.classification_log_channel_id;
        if (!channelId || !authorized(isAuthorized)) return;

        try {
            const channel = await this.client.channels.fetch(channelId).catch(() => null);
            if (this.client.config.llm_classifier !== config || !authorized(isAuthorized)) return;
            if (!channel || !channel.isTextBased() || !("guildId" in channel) || channel.guildId !== message.guildId) {
                this.failures++;
                return;
            }

            const failed = result.status !== "ok";
            const status = result.providerFailure
                ? `${result.providerFailure.summary}${result.providerFailure.httpStatus ? ` (${result.providerFailure.httpStatus})` : ""}`
                : STATUS_NAMES[result.status];
            const embed = new EmbedBuilder()
                .setTitle("LLM Classification")
                .setColor(failed ? Colors.Orange : result.label === "ROUTE" ? Colors.Green : Colors.Greyple)
                .addFields(
                    { name: "Decision", value: result.label, inline: true },
                    { name: "Status", value: status, inline: true },
                    { name: "Source", value: `[Open message](${message.url})` },
                );

            if (failed && result.providerFailure?.rawOutput && options.includeRawOutput !== false) {
                embed.addFields({ name: "Raw output", value: rawOutputField(result.providerFailure.rawOutput) });
            }

            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            this.sent++;
        } catch {
            this.failures++;
        }
    }
}

function rawOutputField(value: string): string {
    const sanitized = sanitizeSensitiveText(value) || "[redacted]";
    const escaped = sanitized.replace(/```/g, "``\u200b`");
    const output = escaped.length > 980 ? `${escaped.slice(0, 980)}\n[truncated]` : escaped;
    return `\`\`\`\n${output}\n\`\`\``;
}
