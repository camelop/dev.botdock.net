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

type AliasColor = { name: AliasColorKey; label: string; swatch: string; accent: string };

export const ALIAS_COLORS: AliasColor[] = [
  { name: "none",   label: "None",    swatch: "transparent", accent: "var(--accent)" },
  { name: "red",    label: "Red",     swatch: "#ef6b6b",     accent: "#ef6b6b" },
  { name: "orange", label: "Orange",  swatch: "#f2994b",     accent: "#f2994b" },
  { name: "yellow", label: "Yellow",  swatch: "#f2b94b",     accent: "#f2b94b" },
  { name: "green",  label: "Green",   swatch: "#6ecf6e",     accent: "#6ecf6e" },
  { name: "teal",   label: "Teal",    swatch: "#4bc4c4",     accent: "#4bc4c4" },
  { name: "blue",   label: "Blue",    swatch: "#6aa4ff",     accent: "#6aa4ff" },
  { name: "purple", label: "Purple",  swatch: "#b388ff",     accent: "#b388ff" },
  { name: "pink",   label: "Pink",    swatch: "#e57fb7",     accent: "#e57fb7" },
];

export function aliasColor(key?: string): AliasColor | undefined {
  if (!key) return undefined;
  return ALIAS_COLORS.find((c) => c.name === key);
}

/** The default accent (used when the user hasn't picked a color). */
export const DEFAULT_ALIAS_ACCENT = "var(--accent)";
