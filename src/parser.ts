import type { Program } from "./types";
import type { Isa } from "./isa/types";
import { AppError } from "./types";

// ─── Program parser ───────────────────────────────────────────────────────────
// Splits a program into labels and instruction lines; the ISA parses each line.

export type ParsedLine<P = unknown> = { labels: string[]; raw: string; parsed: P };

export type ParsedProgram<P = unknown> = {
  lines: ParsedLine<P>[];
  /** Labels with no instruction after them. */
  trailingLabels: string[];
};

export function parseProgram<P>(prog: Program, isa: Isa<P>): ParsedProgram<P> | AppError {
  const lines: ParsedLine<P>[] = [];
  // Consecutive labels all attach to the next instruction.
  let pending: string[] = [];
  for (const rawLine of prog.assembly.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(isa.lineComment)) continue;
    if (line.endsWith(":")) {
      pending.push(line.slice(0, -1).trim());
      continue;
    }
    const parsed = isa.parseInstr(line);
    if (parsed instanceof AppError) return parsed;
    lines.push({ labels: pending, raw: line, parsed });
    pending = [];
  }
  return { lines, trailingLabels: pending };
}
