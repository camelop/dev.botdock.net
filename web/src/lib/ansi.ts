/**
 * Minimal ANSI SGR (Select Graphic Rendition) parser.
 *
 * Scope:
 *   - 16 standard + bright colors (fg 30-37/90-97, bg 40-47/100-107)
 *   - 256-color (38;5;N / 48;5;N)
 *   - truecolor (38;2;R;G;B / 48;2;R;G;B)
 *   - bold / dim / italic / underline / inverse / reset
 *   - Everything else (cursor move, clear screen, OSC, DCS, bracketed paste)
 *     is silently stripped so it doesn't render as garbage. We are NOT a full
 *     terminal emulator — the result is a scrolling transcript with color.
 */

export type AnsiSpan = {
  text: string;
  style: AnsiStyle;
};

export type AnsiStyle = {
  fg?: string;           // CSS color
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

// Standard 16-color xterm palette (approx values).
const BASIC: string[] = [
  "#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

function color256(n: number): string {
  if (n < 16) return BASIC[n]!;
  if (n < 232) {
    const x = n - 16;
    const r = Math.floor(x / 36) * 51;
    const g = Math.floor((x / 6) % 6) * 51;
    const b = (x % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  // grayscale ramp (232-255)
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function applySgr(style: AnsiStyle, codes: number[]): AnsiStyle {
  const out: AnsiStyle = { ...style };
  let i = 0;
  while (i < codes.length) {
    const c = codes[i]!;
    if (c === 0) {
      // Reset all.
      for (const k of Object.keys(out)) delete (out as Record<string, unknown>)[k];
    } else if (c === 1)  out.bold = true;
    else if (c === 2)    out.dim = true;
    else if (c === 3)    out.italic = true;
    else if (c === 4)    out.underline = true;
    else if (c === 7)    out.inverse = true;
    else if (c === 22) { out.bold = false; out.dim = false; }
    else if (c === 23)   out.italic = false;
    else if (c === 24)   out.underline = false;
    else if (c === 27)   out.inverse = false;
    else if (c === 39)   delete out.fg;
    else if (c === 49)   delete out.bg;
    else if (c >= 30 && c <= 37)   out.fg = BASIC[c - 30];
    else if (c >= 40 && c <= 47)   out.bg = BASIC[c - 40];
    else if (c >= 90 && c <= 97)   out.fg = BASIC[c - 90 + 8];
    else if (c >= 100 && c <= 107) out.bg = BASIC[c - 100 + 8];
    else if (c === 38 || c === 48) {
      const target: "fg" | "bg" = c === 38 ? "fg" : "bg";
      const mode = codes[i + 1];
      if (mode === 5 && codes[i + 2] !== undefined) {
        out[target] = color256(codes[i + 2]!);
        i += 2;
      } else if (mode === 2 && codes[i + 2] !== undefined && codes[i + 3] !== undefined && codes[i + 4] !== undefined) {
        out[target] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      } else {
        // Unknown extended mode — skip the sub-params best-effort.
        i += 1;
      }
    }
    // Unknown codes silently ignored.
    i++;
  }
  return out;
}

/**
 * Parse ANSI-flavored text into a flat array of styled spans.
 * Stripped: OSC (\x1b]...\x07), DCS-style, bracketed-paste toggles, cursor
 * moves (\x1b[... <letter != m>), and the `\x1b(B` / `\x1b[?25h` family.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let buf = "";
  const flush = () => {
    if (buf.length) {
      out.push({ text: buf, style });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== "\x1b") {
      buf += ch;
      i++;
      continue;
    }
    // Escape sequence. Figure out its length and whether we care.
    const next = text[i + 1];
    if (next === "[") {
      // CSI: ESC [ ... letter
      const start = i + 2;
      let j = start;
      while (j < text.length) {
        const c = text[j]!;
        if (c >= "@" && c <= "~") break; // final byte
        j++;
      }
      if (j >= text.length) { i = text.length; break; } // truncated
      const params = text.slice(start, j);
      const final = text[j]!;
      if (final === "m") {
        flush();
        // SGR: split semicolons, treat empty as 0.
        const codes = params.length === 0
          ? [0]
          : params.split(";").map((p) => p === "" ? 0 : parseInt(p, 10) || 0);
        style = applySgr(style, codes);
      }
      // Any other final is a cursor/erase/etc. op — strip (do nothing).
      i = j + 1;
    } else if (next === "]") {
      // OSC: ESC ] ... (BEL | ESC \)
      let j = i + 2;
      while (j < text.length) {
        if (text[j] === "\x07") { j++; break; }
        if (text[j] === "\x1b" && text[j + 1] === "\\") { j += 2; break; }
        j++;
      }
      i = j;
    } else if (next === "(") {
      // Charset select: ESC ( <char>
      i += 3;
    } else if (next !== undefined) {
      i += 2;
    } else {
      break;
    }
  }
  flush();
  return out;
}

/** Convert a parsed span to a CSS style object for React. */
export function spanStyle(s: AnsiStyle): React.CSSProperties {
  const css: React.CSSProperties = {};
  const fg = s.inverse ? s.bg : s.fg;
  const bg = s.inverse ? s.fg : s.bg;
  if (fg) css.color = fg;
  if (bg) css.background = bg;
  if (s.bold)       css.fontWeight = 600;
  if (s.dim)        css.opacity = 0.7;
  if (s.italic)     css.fontStyle = "italic";
  if (s.underline)  css.textDecoration = "underline";
  return css;
}
