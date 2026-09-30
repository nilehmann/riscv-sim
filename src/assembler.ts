import type { Program, AssemblyResult, SourceInstr } from "./types";
import type { Isa } from "./isa/types";
import { AppError } from "./types";
import { getIsa } from "./isa";
import { parseProgram } from "./parser";

// ─── Assembler ────────────────────────────────────────────────────────────
// Instruction sizes can depend on label addresses (RISC-V `call` is jal or
// auipc+jalr, x86 jumps are short or near), and label addresses depend on
// sizes. Start from each line's maximum size and re-expand every line against
// the current layout until sizes stop changing. Sizes only shrink from the
// maximum, so this converges; errors are reported for the final layout only,
// since earlier ones may disappear once the code shrinks.

const MAX_LAYOUT_PASSES = 32;

export function assembleProgram(
  prog: Program,
  isa: Isa = getIsa(prog.isa),
): AssemblyResult | AppError {
  const parsedProgram = parseProgram(prog, isa);
  if (parsedProgram instanceof AppError) return parsedProgram;
  const { lines, trailingLabels } = parsedProgram;

  // The first definition of a label wins.
  const define = (table: Record<string, number>, name: string, at: number) => {
    if (!Object.prototype.hasOwnProperty.call(table, name)) table[name] = at;
  };

  function layout(sizes: number[]) {
    const starts: number[] = [];
    const labels: Record<string, number> = {};
    let addr = prog.baseAddress;
    lines.forEach((line, i) => {
      starts.push(addr);
      for (const name of line.labels) define(labels, name, addr);
      addr += sizes[i]!;
    });
    // Trailing labels point just past the last instruction.
    for (const name of trailingLabels) define(labels, name, addr);
    return { starts, labels, end: addr };
  }

  let sizes = lines.map((l) => isa.maxSize(l.parsed));
  for (let pass = 0; ; pass++) {
    const { starts, labels, end } = layout(sizes);
    let firstError = null as AppError | null;
    const expanded = lines.map((line, i) => {
      const r = isa.expand(line.parsed, {
        addr: starts[i]!,
        labels,
        raw: line.raw,
        lineLabels: line.labels,
      });
      if (r instanceof AppError) {
        firstError ??= r;
        return null;
      }
      return r;
    });
    // A line that failed keeps its previous size until the layout settles.
    const newSizes = expanded.map((instrs, i) =>
      instrs ? instrs.reduce((n, instr) => n + isa.size(instr), 0) : sizes[i]!,
    );

    if (newSizes.every((s, i) => s === sizes[i])) {
      if (firstError) return firstError;
      const sourceInstrs: SourceInstr[] = [];
      const addrToSourceIdx = new Map<number, number>();
      lines.forEach((line, i) => {
        let addr = starts[i]!;
        const concretes = expanded[i]!.map((instr) => {
          const c = { instr, addr, size: isa.size(instr) };
          addrToSourceIdx.set(addr, i);
          addr += c.size;
          return c;
        });
        sourceInstrs.push({
          labels: line.labels,
          raw: line.raw,
          parsed: line.parsed,
          concretes,
          firstAddr: starts[i]!,
        });
      });
      return { sourceInstrs, addrToSourceIdx, labels, trailingLabels, endAddr: end };
    }

    if (pass === MAX_LAYOUT_PASSES)
      return firstError ?? new AppError("Instruction sizes did not settle");
    sizes = newSizes;
  }
}
