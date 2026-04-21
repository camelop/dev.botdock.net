/**
 * Shared display for a session's name/id with the user's chosen alias +
 * accent color applied consistently across Dashboard / List / Card view /
 * Workspace sidebar. When an alias_color is set it paints the chip's
 * background; foreground flips dark/light via the alias-colors table so
 * it stays readable. The underlying session id + cmd + machine/workdir
 * are tucked into a multi-line hover tooltip so the original label never
 * disappears — the user can still see and copy the id when they need to.
 */
import type { Session } from "../api";
import { aliasColor } from "../lib/alias-colors";

export function SessionNameChip({ session, fallback, size, title }: {
  session: Session;
  /** Text to show when session.alias is empty. Defaults to session.id. */
  fallback?: string;
  /** Font size in px. Defaults to 13 (same as the sidebar's row label). */
  size?: number;
  /** Override the default multi-line hover tooltip. */
  title?: string;
}) {
  const alias = session.alias && session.alias.trim().length > 0
    ? session.alias.trim()
    : undefined;
  const text = alias ?? (fallback && fallback.length > 0 ? fallback : session.id);
  const color = aliasColor(session.alias_color);
  const hasColor = !!color && color.name !== "none";

  const defaultTitle = [
    `id: ${session.id}`,
    session.cmd ? `cmd: ${session.cmd}` : null,
    `${session.machine} · ${session.workdir}`,
  ].filter(Boolean).join("\n");

  return (
    <span
      className="mono"
      title={title ?? defaultTitle}
      style={{
        fontSize: size ?? 13,
        ...(hasColor ? {
          background: color!.bg,
          color: color!.fg,
          padding: "1px 6px",
          borderRadius: 4,
          display: "inline-block",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          verticalAlign: "middle",
        } : {}),
      }}
    >
      {text}
    </span>
  );
}
