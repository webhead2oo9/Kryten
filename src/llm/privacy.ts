import { isIP } from "node:net";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu;
const IPV6_CANDIDATE = /(?<![A-F0-9:])(?:[A-F0-9]{0,4}:){2,7}[A-F0-9]{0,4}(?![A-F0-9:])/giu;
const MAC_ADDRESS = /\b(?:[A-F0-9]{2}[:-]){5}[A-F0-9]{2}\b/giu;
const PHONE_NUMBER = /(?<![\w.])\+?\d(?:[\s().-]*\d){7,14}(?![\w.])/gu;
const AUTHORIZATION_HEADER = /\b((?:proxy-)?authorization)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/giu;
const BEARER_CREDENTIAL = /\b(?:authorization["']?\s*[:=]\s*["']?\s*)?bearer\s+\S+/giu;
const SECRET_ASSIGNMENT = /\b(api[_ -]?key|password|secret|token)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/giu;
const TOKEN_SHAPE = /\b(?:fw|ghp|github_pat|sk)[_-][A-Za-z0-9_-]{12,}\b/gu;
const JWT_OR_DISCORD_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/gu;

export function sanitizeSensitiveText(input: string, channelLabels: Readonly<Record<string, string>> = {}): string {
    return input
        .replace(/<@!?\d+>/g, "@member")
        .replace(/<@&\d+>/g, "@role")
        .replace(/<#(\d+)>/g, (_match, id: string) => `#${channelLabels[id] ?? "channel"}`)
        .replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:")
        .replace(EMAIL, "[email omitted]")
        .replace(IPV4, "[IP address omitted]")
        .replace(MAC_ADDRESS, "[MAC address omitted]")
        .replace(IPV6_CANDIDATE, value => (isIP(value) === 6 ? "[IP address omitted]" : value))
        .replace(AUTHORIZATION_HEADER, "$1=[secret omitted]")
        .replace(BEARER_CREDENTIAL, "Bearer [secret omitted]")
        .replace(SECRET_ASSIGNMENT, "$1=[secret omitted]")
        .replace(TOKEN_SHAPE, "[secret omitted]")
        .replace(JWT_OR_DISCORD_TOKEN, "[secret omitted]")
        .replace(/https?:\/\/\S+/giu, "[link omitted]")
        .replace(/\b\d{17,20}\b/gu, "[id omitted]")
        .replace(PHONE_NUMBER, "[phone number omitted]")
        .replace(/\s+$/g, "")
        .trim();
}
