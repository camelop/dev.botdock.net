/**
 * Shared palette for user-chosen session accent colors. Keep the list
 * short so the picker stays a compact row and the eye can tell colors
 * apart at a glance. Values are tuned for the dark theme.
 *
 * The palette is keyed by a stable name so the server can persist just
 * the name in meta.toml without caring about hex values; renaming a key
 * would lose the user's choice, so treat these like enum members.
 */
export type AliasColorKey =
  | "none"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "purple"
  | "pink";

type AliasColor = {
  name: AliasColorKey;
  label: string;
  /** Background fill on the sidebar row's name pill. */
  bg: string;
  /** Text color on top of bg, picked by luminance. */
  fg: string;
  /** Accent used for the row's left border. */
  accent: string;
};

// fg is picked by eyeballing luminance on the dark theme — dark text on
// warm/light backgrounds (red, orange, yellow, green, teal, pink), white
// on deeper hues (blue, purple). Keeping it explicit beats computing
// 0.299r + 0.587g + 0.114b at the edge of every row.
export const ALIAS_COLORS: AliasColor[] = [
  { name: "none",   label: "None",    bg: "transparent", fg: "var(--fg)",  accent: "var(--accent)" },
  { name: "red",    label: "Red",     bg: "#ef6b6b",     fg: "#1a0606",    accent: "#ef6b6b" },
  { name: "orange", label: "Orange",  bg: "#f2994b",     fg: "#1f0f03",    accent: "#f2994b" },
  { name: "yellow", label: "Yellow",  bg: "#f2b94b",     fg: "#1f1603",    accent: "#f2b94b" },
  { name: "green",  label: "Green",   bg: "#6ecf6e",     fg: "#061a06",    accent: "#6ecf6e" },
  { name: "teal",   label: "Teal",    bg: "#4bc4c4",     fg: "#061a1a",    accent: "#4bc4c4" },
  { name: "blue",   label: "Blue",    bg: "#6aa4ff",     fg: "#071225",    accent: "#6aa4ff" },
  { name: "purple", label: "Purple",  bg: "#b388ff",     fg: "#130625",    accent: "#b388ff" },
  { name: "pink",   label: "Pink",    bg: "#e57fb7",     fg: "#200916",    accent: "#e57fb7" },
];

export function aliasColor(key?: string): AliasColor | undefined {
  if (!key) return undefined;
  return ALIAS_COLORS.find((c) => c.name === key);
}

/** The default accent (used when the user hasn't picked a color). */
export const DEFAULT_ALIAS_ACCENT = "var(--accent)";
