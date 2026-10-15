/**
 * Loot Shelf — its instances of the Open Roll 5e kit (scripts/kit/, byte-identical across the
 * family): the logger every file writes through, and the elect that decides which client acts.
 * The receipts are the transfer kernel's (transfer.js), since the kernel is what they record.
 */

import { createElect } from "./kit/elect.js";
import { createLogger } from "./kit/log.js";

export const MODULE_ID = "fvtt-mod-lootshelf";

/** Every line opens with the module's title; debug lines need CONFIG.debug["fvtt-mod-lootshelf"]. */
export const log = createLogger(MODULE_ID);

/**
 * The one client that answers the kernel's socket and makes world writes every client would
 * otherwise repeat: the active GM, in its leading window, once the world is ready.
 */
export const elect = createElect(MODULE_ID, { log });
