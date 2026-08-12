import { sanitizeSensitiveText } from "../../llm/privacy";

const MAX_MESSAGE_CHARACTERS = 4_000;

export interface TranscriptMessage {
    id: string;
    authorId: string;
    content: string;
    createdTimestamp: number;
    isBot: boolean;
    isStaff: boolean;
    replyToId?: string;
}

export interface TranscriptOptions {
    maxMessages: number;
    maxCharacters: number;
    referencedParentId?: string;
    channelLabels?: Readonly<Record<string, string>>;
}

export function buildClassificationTranscript(
    messages: readonly TranscriptMessage[],
    targetId: string,
    options: TranscriptOptions,
): string | null {
    const target = messages.find(message => message.id === targetId);
    if (!target) return null;

    const byId = new Map<string, TranscriptMessage>();
    for (const message of messages) {
        if (message.createdTimestamp <= target.createdTimestamp) byId.set(message.id, message);
    }
    byId.set(target.id, target);

    const prior = [...byId.values()]
        .filter(message => message.id !== target.id)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id));
    const priorLimit = Math.max(0, options.maxMessages - 1);
    let selectedPrior = prior.slice(-priorLimit);

    const referencedParent = options.referencedParentId ? byId.get(options.referencedParentId) : undefined;
    if (referencedParent && priorLimit > 0 && !selectedPrior.some(message => message.id === referencedParent.id)) {
        selectedPrior = [
            referencedParent,
            ...prior.filter(message => message.id !== referencedParent.id).slice(-(priorLimit - 1)),
        ];
        selectedPrior.sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id));
    }

    const selected = [...selectedPrior, target];
    const prefix = "Conversation before and including the target message:\n\n";
    const serialize = (items: TranscriptMessage[], contentLimit: number): string => {
        const speakerNames = new Map<string, string>();
        for (const item of items) {
            if (!speakerNames.has(item.authorId)) {
                speakerNames.set(item.authorId, `member_${alphabeticIndex(speakerNames.size)}`);
            }
        }
        const selectedById = new Map(items.map(item => [item.id, item]));
        const rendered = items.map((item, index) => {
            const speaker = speakerNames.get(item.authorId)!;
            const role = item.isBot ? "bot" : item.isStaff ? "staff" : "member";
            const replySpeaker = item.replyToId
                ? speakerNames.get(selectedById.get(item.replyToId)?.authorId ?? "")
                : undefined;
            const metadata = [`speaker=${speaker}`, `role=${role}`];
            if (replySpeaker) metadata.push(`reply_to=${replySpeaker}`);
            if (item.id === target.id) metadata.push("TARGET");
            const content =
                sanitizeSensitiveText(item.content, options.channelLabels).slice(0, contentLimit) || "[no text]";
            return `[${index + 1}] ${metadata.join(" ")}\n${content}`;
        });
        return `${prefix}${rendered.join("\n\n")}`;
    };

    const selectedWithinLimit = [...selected];
    while (serialize(selectedWithinLimit, MAX_MESSAGE_CHARACTERS).length > options.maxCharacters) {
        const removable = selectedWithinLimit.findIndex(
            item => item.id !== target.id && item.id !== referencedParent?.id,
        );
        if (removable < 0) break;
        selectedWithinLimit.splice(removable, 1);
    }

    let low = 0;
    let high = MAX_MESSAGE_CHARACTERS;
    let transcript = serialize(selectedWithinLimit, 0);
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = serialize(selectedWithinLimit, middle);
        if (candidate.length <= options.maxCharacters) {
            transcript = candidate;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return transcript;
}

function alphabeticIndex(index: number): string {
    let value = index;
    let output = "";
    do {
        output = String.fromCharCode(97 + (value % 26)) + output;
        value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return output;
}
