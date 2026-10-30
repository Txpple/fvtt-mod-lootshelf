// How a loot container's token looks (scripts/dropped-look.js): loot on the ground small, its own
// art for one item, a sack for a pile or an artless item; a placed chest as given.
import { BAG_ICON, DROPPED_SCALE, SACK_ICON, containerLook } from "../scripts/dropped-look.js";

describe("containerLook", () => {
  it("one dropped item: its own art, small", () => {
    expect(
      containerLook({ img: "icons/weapons/dagger.webp", itemCount: 1, ephemeral: true })
    ).toEqual({
      src: "icons/weapons/dagger.webp",
      scale: DROPPED_SCALE
    });
  });
  it("a companion's gear, several items: a sack, small, whatever art was passed", () => {
    expect(
      containerLook({ img: "icons/weapons/dagger.webp", itemCount: 3, ephemeral: true })
    ).toEqual({
      src: SACK_ICON,
      scale: DROPPED_SCALE
    });
  });
  it("a dropped item with no art of its own: a sack", () => {
    expect(containerLook({ img: BAG_ICON, itemCount: 1, ephemeral: true }).src).toBe(SACK_ICON);
    expect(containerLook({ itemCount: 1, ephemeral: true }).src).toBe(SACK_ICON);
  });
  it("a chest the GM places: full size, the art given, else the bag", () => {
    expect(containerLook({ img: "art/chest.webp", itemCount: 4 })).toEqual({
      src: "art/chest.webp",
      scale: 1
    });
    expect(containerLook({})).toEqual({ src: BAG_ICON, scale: 1 });
  });
  it("loot on the ground fills less than its square", () => {
    expect(DROPPED_SCALE).toBeGreaterThan(0);
    expect(DROPPED_SCALE).toBeLessThan(1);
  });
});
