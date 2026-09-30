const VARIABLES = new Set(["user", "target", "announcements"]);

export function validateCampaignTemplate(template: string): void {
    if (!template.trim() || template.length > 2_000) throw new Error("template must contain 1-2000 characters");
    const remainder = template.replace(/\{([a-z]+)\}/g, (_match, name: string) => {
        if (!VARIABLES.has(name)) throw new Error("unknown template variable");
        return "";
    });
    if (/[{}]/.test(remainder)) throw new Error("malformed template variable");
}

export function renderCampaignTemplate(template: string, values: Partial<Record<string, string>>): string {
    validateCampaignTemplate(template);
    const result = template.replace(/\{([a-z]+)\}/g, (_match, name: string) => {
        const value = values[name];
        if (!value) throw new Error("missing template value");
        return value;
    });
    if (result.length > 2_000) throw new Error("rendered template exceeds message limit");
    return result;
}
