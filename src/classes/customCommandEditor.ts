import { CommandBlock, CustomCommand } from "../types";
import { jsonClone } from "../utils/jsonClone";

export type EditorSection = "general" | "embed" | "page";

export interface EditorSession {
    userId: string;
    commands: CustomCommand[];
    selectedCommandName?: string;
    selectedSection?: EditorSection;
    selectedPageName?: string;
    /**
     * Block cursor into the viewed unit's blocks (the command's own when the
     * section is "embed", the selected page's when "page"). Must be cleared
     * whenever the viewed unit changes — `setView` owns that — or its block
     * list is rewritten wholesale (the JSON modals clear it by hand), since a
     * stale index would silently retarget another block.
     */
    selectedBlockIndex?: number;
    /**
     * Snapshot of the block an Edit Block modal was opened for. The modal's
     * custom-id anchors by index, but indices aren't identity — a reorder
     * that puts a same-typed block at that index would let a stale submit
     * clobber it. The submit refuses unless the block at the scoped index
     * still deep-equals this snapshot.
     */
    pendingBlockEdit?: { unitTag: string; index: number; block: CommandBlock };
    hasUnsavedChanges: boolean;
    originalCommands: CustomCommand[];
    lastTouched: number;
    statusMessage?: string;
    responseToken?: string;
    applicationId?: string;
    /**
     * Per-command GitHub blob SHAs snapshotted when the working copy was
     * refreshed, for per-file lost-update conflict detection on save.
     * `undefined` means the revision is unknown (degraded load) — saves that
     * touch existing files must refuse rather than blind-write.
     */
    fileShas?: Record<string, string>;
    /**
     * Files committed to GitHub by an earlier PARTIAL save attempt that have
     * not yet been applied to the live corpus/snapshot (a mid-batch failure
     * returns before applyLocal, and advanceBaseline removes those files from
     * the next retry's diff). Drained by the next successful save so live
     * state converges with what actually landed on GitHub.
     */
    pendingSync?: {
        upserts: Record<string, CustomCommand>;
        deletes: string[];
        /**
         * Slash-command registration state from before the first partial
         * commit in this chain. Live command bodies advance per committed file,
         * but registration only runs after a fully successful save/retry.
         */
        registrationBaseline: CustomCommand[];
    };
    /**
     * True while a Save is committing to GitHub. The editor message stays
     * interactive across that async round-trip, so other interactions on the
     * session are refused while this is set — a mutation landing mid-save would
     * change the body being committed and get its dirty flag clobbered when the
     * save finishes.
     */
    saving?: boolean;
}

export class CustomCommandEditor {
    private static readonly SESSION_TTL_MS = 30 * 60 * 1000;
    private readonly sessions = new Map<string, EditorSession>();
    /**
     * Invoked when a stale session that still carries `pendingSync` is evicted,
     * so an earlier partial save's committed-but-unregistered files get caught
     * up instead of dropped. Wired at startup to `drainPendingSync`; left unset
     * in tests (eviction then just drops the session, as before).
     */
    private onEvictWithPendingSync?: (session: EditorSession) => void;

    setPendingSyncDrainer(fn: (session: EditorSession) => void): void {
        this.onEvictWithPendingSync = fn;
    }

    createDefaultCommand(name: string): CustomCommand {
        name = name.toLowerCase();
        // New commands are born format 2 (block-based); format-1 embed files
        // remain editable until they are migrated.
        return {
            format: 2,
            name,
            description: "Describe this command",
            blocks: [
                { type: "heading", text: name },
                { type: "text", text: "Update this description." },
            ],
        };
    }

    /** Drop sessions idle past the TTL so abandoned editors don't leak memory. */
    private pruneStaleSessions(): void {
        const now = Date.now();
        for (const [userId, session] of this.sessions) {
            if (now - session.lastTouched > CustomCommandEditor.SESSION_TTL_MS) {
                this.sessions.delete(userId);
                // Hand off any pendingSync so a partial save's committed-but-
                // unregistered files finish syncing instead of being orphaned.
                if (session.pendingSync && this.onEvictWithPendingSync) {
                    this.onEvictWithPendingSync(session);
                }
            }
        }
    }

    /**
     * Peek at an existing session without creating one. Editor components only
     * exist on messages produced by an open session, so a miss here means the
     * session expired (TTL) or the bot restarted — callers should tell the user
     * to reopen the editor rather than silently operate on a fresh disk copy.
     */
    getSession(userId: string): EditorSession | undefined {
        this.pruneStaleSessions();
        const session = this.sessions.get(userId);
        if (session) session.lastTouched = Date.now();
        return session;
    }

    /**
     * Sessions seed from the LIVE in-memory corpus (deep-cloned) — the save
     * path diffs against `originalCommands` and merges into the live corpus,
     * so seeding from anywhere else could produce spurious diff entries.
     */
    getOrCreateSession(userId: string, liveCommands: CustomCommand[]): EditorSession {
        this.pruneStaleSessions();
        const existing = this.sessions.get(userId);
        if (existing) {
            existing.lastTouched = Date.now();
            return existing;
        }

        const session: EditorSession = {
            userId,
            commands: jsonClone(liveCommands),
            selectedCommandName: undefined,
            selectedSection: undefined,
            selectedPageName: undefined,
            selectedBlockIndex: undefined,
            hasUnsavedChanges: false,
            originalCommands: jsonClone(liveCommands),
            lastTouched: Date.now(),
            statusMessage: undefined,
            responseToken: undefined,
            applicationId: undefined,
            fileShas: undefined,
        };

        this.sessions.set(userId, session);
        return session;
    }

    endSession(userId: string) {
        this.sessions.delete(userId);
    }

    markDirty(session: EditorSession) {
        session.hasUnsavedChanges = true;
        session.lastTouched = Date.now();
        session.statusMessage = "Unsaved changes";
    }

    /**
     * Change the viewed section/page. Owns clearing the block cursor so a
     * view change can never leave a stale index pointing into another unit's
     * blocks — every path that moves the view must come through here.
     */
    setView(session: EditorSession, section: EditorSection | undefined, pageName: string | undefined) {
        session.selectedSection = section;
        session.selectedPageName = pageName;
        session.selectedBlockIndex = undefined;
    }

    resetSession(session: EditorSession) {
        session.commands = jsonClone(session.originalCommands);
        if (session.selectedCommandName && !session.commands.find(c => c.name === session.selectedCommandName)) {
            session.selectedCommandName = session.commands[0]?.name;
        }
        const cmd = session.selectedCommandName
            ? session.commands.find(c => c.name === session.selectedCommandName)
            : undefined;
        this.setView(session, session.commands.length ? "general" : undefined, cmd?.pages?.[0]?.name);
        session.hasUnsavedChanges = false;
        session.lastTouched = Date.now();
        session.statusMessage = "Changes discarded.";
    }

    getSelectedCommand(session: EditorSession): CustomCommand | undefined {
        if (!session.selectedCommandName) return undefined;
        return session.commands.find(c => c.name === session.selectedCommandName);
    }

    getSelectedPage(session: EditorSession) {
        const command = this.getSelectedCommand(session);
        if (!command || !session.selectedPageName) return undefined;
        return command.pages?.find(p => p.name === session.selectedPageName);
    }

    selectCommand(session: EditorSession, name: string): CustomCommand | undefined {
        session.selectedCommandName = name;
        const command = this.getSelectedCommand(session);
        this.setView(session, "general", command?.pages?.length ? command.pages[0]?.name : undefined);
        return command;
    }

    addNewCommand(session: EditorSession, name: string): CustomCommand {
        const newCommand = this.createDefaultCommand(name);
        session.commands.push(newCommand);
        session.selectedCommandName = name;
        this.setView(session, "general", undefined);
        session.hasUnsavedChanges = true;
        session.statusMessage = `Created command '${name}'.`;
        return newCommand;
    }

    refreshCommands(session: EditorSession, liveCommands: CustomCommand[]) {
        session.commands = jsonClone(liveCommands);
        session.originalCommands = jsonClone(liveCommands);
        if (session.selectedCommandName && !session.commands.find(c => c.name === session.selectedCommandName)) {
            session.selectedCommandName = undefined;
            this.setView(session, undefined, undefined);
        } else {
            // The view is unchanged but every block list was replaced wholesale.
            session.selectedBlockIndex = undefined;
        }
        session.hasUnsavedChanges = false;
        session.statusMessage = undefined;
    }
}
