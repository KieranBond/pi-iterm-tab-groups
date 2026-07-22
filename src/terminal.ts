/**
 * Safe iTerm terminal adapter.
 * Only TUI+iTerm, no tmux unless forced.
 * Exact validated OSC SetColors/reset bytes.
 * C0/C1 title stripping, whitespace normalization, max 80 code points.
 */

import { TabGroup } from "./types";

export interface TerminalEnvironment {
  getEnv(key: string): string | undefined;
  getMode(): string;
}

export interface TerminalOutput {
  write(data: string): void;
}

export class RealTerminalEnvironment implements TerminalEnvironment {
  constructor(private readonly mode: string) {}

  getEnv(key: string): string | undefined {
    return process.env[key];
  }

  getMode(): string {
    return this.mode;
  }
}

export class RealTerminalOutput implements TerminalOutput {
  write(data: string): void {
    process.stdout.write(data);
  }
}

/**
 * Check if terminal supports iTerm tab colors.
 * Only TUI mode, iTerm.app, and no tmux (unless forced).
 */
export function isTerminalSupported(
  env: TerminalEnvironment,
  force = false
): boolean {
  if (env.getMode() !== "tui") {
    return false;
  }

  const termProgram = env.getEnv("TERM_PROGRAM");
  if (termProgram !== "iTerm.app") {
    return false;
  }

  // Reject tmux unless forced
  const tmux = env.getEnv("TMUX");
  if (tmux && !force) {
    return false;
  }

  return true;
}

/**
 * Validate hex color (must be exactly 6 hex digits).
 */
export function isValidHexColor(color: string): boolean {
  return /^[0-9A-F]{6}$/.test(color);
}

/**
 * Set iTerm tab color using OSC SetColors escape sequence.
 */
export function setTabColor(
  color: string,
  output: TerminalOutput,
  env: TerminalEnvironment,
  force = false
): boolean {
  if (!isTerminalSupported(env, force)) {
    return false;
  }

  if (!isValidHexColor(color)) {
    throw new Error(`Invalid hex color: ${color}`);
  }

  // Exact OSC sequence: ESC ] 1337 ; SetColors=tab=RRGGBB ESC \
  const sequence = `\x1b]1337;SetColors=tab=${color}\x1b\\`;
  output.write(sequence);
  return true;
}

/**
 * Reset iTerm tab color to default.
 */
export function resetTabColor(
  output: TerminalOutput,
  env: TerminalEnvironment,
  force = false
): boolean {
  if (!isTerminalSupported(env, force)) {
    return false;
  }

  // Exact OSC sequence: ESC ] 1337 ; SetColors=tab=default ESC \
  const sequence = `\x1b]1337;SetColors=tab=default\x1b\\`;
  output.write(sequence);
  return true;
}

/**
 * Sanitize a title string:
 * - Strip C0 control characters (\x00-\x1f)
 * - Strip C1 control characters (\x7f-\x9f)
 * - Normalize whitespace (collapse multiple spaces, trim)
 * - Cap at 80 Unicode code points
 */
export function sanitizeTitle(title: string, maxCodePoints = 80): string {
  // Strip C0 and C1 control characters
  let sanitized = title.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  // Cap at max code points (not bytes)
  const codePoints = Array.from(sanitized);
  if (codePoints.length > maxCodePoints) {
    sanitized = codePoints.slice(0, maxCodePoints).join("");
  }

  return sanitized;
}

/**
 * Set terminal title prefix for a group.
 * This is separate from tab color and provides redundant accessible label.
 */
export interface TitleSetter {
  setTitle(title: string): void;
}

export class FakeTitleSetter implements TitleSetter {
  public titles: string[] = [];

  setTitle(title: string): void {
    this.titles.push(title);
  }

  getLastTitle(): string | undefined {
    return this.titles[this.titles.length - 1];
  }
}

/**
 * Apply a group's color and title to the terminal.
 */
export function applyGroupStyle(
  group: TabGroup | null,
  output: TerminalOutput,
  env: TerminalEnvironment,
  titleSetter?: TitleSetter,
  force = false,
  titleSuffix = "",
): boolean {
  if (!isTerminalSupported(env, force)) return false;

  if (group) {
    setTabColor(group.colour, output, env, force);
    if (titleSetter) {
      const label = sanitizeTitle(group.label, 48);
      const remaining = Math.max(0, 80 - Array.from(label).length - 3);
      const suffix = sanitizeTitle(titleSuffix, remaining);
      titleSetter.setTitle(`[${label}]${suffix ? ` ${suffix}` : ""}`);
    }
    return true;
  }

  resetTabColor(output, env, force);
  titleSetter?.setTitle(sanitizeTitle(titleSuffix));
  return true;
}
