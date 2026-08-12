import { Config } from "../types";

/**
 * The single staff-membership rule (staff gating is a security boundary —
 * command handling, context menus, and proposal review must all agree).
 * Handles both member shapes discord.js exposes: raw role-id arrays
 * (API interaction members) and cached GuildMember role managers.
 * Fails closed when staff_roles is missing/empty or the member is unknown.
 */
export function memberHasStaffRole(member: unknown, config: Config): boolean {
    const staffRoles = Array.isArray(config.staff_roles) ? config.staff_roles : [];
    if (config.staff_roles !== undefined && !Array.isArray(config.staff_roles)) {
        console.error("config.staff_roles must be an array of role id strings; treating as empty (no staff).");
    }
    return memberHasAnyRole(member, staffRoles);
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
