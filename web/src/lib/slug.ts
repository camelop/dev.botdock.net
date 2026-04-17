const ADJECTIVES = [
  "amber", "bold", "brave", "bright", "calm", "chill", "clever", "crisp",
  "dandy", "eager", "fair", "fresh", "gentle", "glad", "jolly", "keen",
  "kind", "lively", "lucky", "merry", "mighty", "neat", "nimble", "plucky",
  "proud", "quick", "quiet", "sharp", "snappy", "snug", "steady", "sturdy",
  "sunny", "swift", "true", "vivid", "warm", "wise", "witty", "zesty",
];

const NOUNS = [
  "acorn", "anchor", "beacon", "breeze", "canyon", "comet", "copper", "delta",
  "ember", "falcon", "fern", "forest", "glacier", "harbor", "heather", "iris",
  "juniper", "lantern", "maple", "meadow", "moss", "oak", "ocean", "orchard",
  "otter", "pebble", "pine", "prairie", "quill", "raven", "ridge", "river",
  "rook", "sage", "summit", "thicket", "tide", "tundra", "willow", "zephyr",
];

/** Two-word slug like "bright-otter". */
export function twoWordSlug(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}`;
}
