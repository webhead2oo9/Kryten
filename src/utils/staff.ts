import type { Message } from "discord.js";
import type { Config } from "../types";

function staffRoleIds(config: Config): readonly string[] {
    if (config.staff_roles !== undefined && !Array.isArray(config.staff_roles)) {
        console.error("config.staff_roles must be an array of role id strings; treating as empty (no staff).");
    }
    return Array.isArray(config.staff_roles) ? config.staff_roles : [];
}

/**
 * The single staff-membership rule (staff gating is a security boundary —
 * command handling, context menus, and proposal review must all agree).
 * Handles both member shapes discord.js exposes: raw role-id arrays
 * (API interaction members) and cached GuildMember role managers.
 * Fails closed when staff_roles is missing/empty or the member is unknown.
 */
export function memberHasStaffRole(member: unknown, config: Config): boolean {
    return memberHasAnyRole(member, staffRoleIds(config));
}

export function memberHasAnyRole(member: unknown, roleIds: readonly string[]): boolean {
    if (!member || !roleIds.length) return false;
    const roles = (member as { roles?: unknown }).roles;
    if (Array.isArray(roles)) {
        return roles.some((roleId: unknown) => typeof roleId === "string" && roleIds.includes(roleId));
    }
    const roleCache = (roles as { cache?: { some: (fn: (role: { id: string }) => boolean) => boolean } } | undefined)
        ?.cache;
    if (!roleCache) return false;
    return roleCache.some(role => roleIds.includes(role.id));
}

/**
 * Shared enforcement exemption: the global staff_roles ∪ a feature's
 * whitelisted_role_ids, resolved against the message's author — fetching the
 * member when uncached (an uncached exempt user must not fall through to
 * enforcement). Returns null when the member can't be resolved at all: the
 * author can't be confirmed non-exempt, so enforcement callers must treat
 * null as fail-closed (skip), never as "not exempt".
 *
 * Assumes GuildMember partials stay disabled (index.ts enables only
 * Partials.Message/Channel), so a non-null member always has roles.cache.
 * Enabling Partials.GuildMember would make a partial member (roles
 * undefined) evaluate as non-exempt — fail-OPEN — so also fetch on that
 * shape if partials ever change.
 */
export async function messageAuthorHasExemptRole(
    message: Message,
    config: Config,
    whitelistedRoleIds: readonly string[],
): Promise<boolean | null> {
    const exemptRoleIds = [...whitelistedRoleIds, ...staffRoleIds(config)];
    if (!exemptRoleIds.length) return false;
    const member = message.member ?? (await message.guild?.members.fetch(message.author.id).catch(() => null));
    if (!member) return null;
    return memberHasAnyRole(member, exemptRoleIds);
}
