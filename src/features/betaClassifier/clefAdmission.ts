const STEAM_EDITION_OR_VERSION = /\bsteam[ -]+(?:edition|version)\b/i;

export function clefRoutingAdmissionExcluded(text: string): boolean {
    return STEAM_EDITION_OR_VERSION.test(text);
}
