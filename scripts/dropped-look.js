/**
 * Loot Shelf — how a loot container's token looks on the map. Pure: no Foundry.
 *
 * Loot left on the ground (an ephemeral container: an item dropped on the map, a companion's gear
 * left where it stood) is drawn small and centred in its square, so it reads as an object lying on
 * the floor rather than a token standing there. One item shows its own art, so a dagger and a
 * potion tell apart at a glance; a pile of several, or an item with no art of its own, shows a
 * sack. A chest the GM places keeps full size and the art it was given.
 */

/** The image Foundry gives an item with no art of its own, and Loot Shelf's chest default. */
export const BAG_ICON = "icons/svg/item-bag.svg";

/** Loot on the ground with no single item's art to show: Foundry's own sack. */
export const SACK_ICON = "icons/containers/bags/sack-cloth-brown.webp";

/** The share of its square dropped loot fills. */
export const DROPPED_SCALE = 0.6;

/**
 * The container's art and its token's scale.
 * @param {{ img?: string|null, itemCount?: number, ephemeral?: boolean }} facts
 * @returns {{ src: string, scale: number }}
 */
export function containerLook({ img = null, itemCount = 0, ephemeral = false } = {}) {
  const ownArt = typeof img === "string" && img && img !== BAG_ICON ? img : null;
  if (!ephemeral) return { src: ownArt ?? BAG_ICON, scale: 1 };
  return { src: itemCount > 1 || !ownArt ? SACK_ICON : ownArt, scale: DROPPED_SCALE };
}
