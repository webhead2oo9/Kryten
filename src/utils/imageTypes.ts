const IMAGE_EXTENSION_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
} as const;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
};

export const RASTER_IMAGE_CONTENT_TYPES = new Set<string>(Object.values(IMAGE_EXTENSION_CONTENT_TYPES));

export function normalizeContentType(value: string | null | undefined): string | null {
    if (!value) return null;
    const contentType = value.split(";", 1)[0]!.trim().toLowerCase();
    return contentType || null;
}

export function isRasterImageContentType(value: string | null | undefined): boolean {
    const contentType = normalizeContentType(value);
    return contentType !== null && RASTER_IMAGE_CONTENT_TYPES.has(contentType);
}

export function contentTypeFromImageName(value: string | null | undefined): string | null {
    if (!value) return null;
    const lowered = value.split("?", 1)[0]!.split("#", 1)[0]!.toLowerCase();
    for (const [suffix, contentType] of Object.entries(IMAGE_EXTENSION_CONTENT_TYPES)) {
        if (lowered.endsWith(suffix)) return contentType;
    }
    return null;
}

export function imageExtensionForContentType(value: string | null | undefined): string | null {
    const contentType = normalizeContentType(value);
    return contentType ? (CONTENT_TYPE_EXTENSIONS[contentType] ?? null) : null;
}
