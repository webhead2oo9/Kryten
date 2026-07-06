import { Interaction } from "discord.js";
import { BaseContextInitOptions } from "../types";
import { KrytenClient } from "./client";
import { memberHasStaffRole } from "../utils/staff";

export class BaseContext {
    interaction: Interaction;
    client: KrytenClient;
    constructor(options: BaseContextInitOptions) {
        this.interaction = options.interaction;
        this.client = options.client;
    }

    get is_staff() {
        return memberHasStaffRole(this.interaction.member, this.client.config);
    }
}
