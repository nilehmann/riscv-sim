import type {
  Program,
  ParsedInstr,
  Instr,
  AssemblyResult,
  SourceInstr,
} from "./types";
import { AppError, hx, imm } from "./types";
import type { Imm } from "./types";
import { parseProgram } from "./parser";

// ─── Helpers ──────────────────────────────────────────────────────────────
export { hx };

// ─── Pseudo-instruction expander ─────────────────────────────────────────
function assembleInstr(
  parsed: ParsedInstr,
  addr: number,
  labels: Record<string, number>,
  raw: string,
  label: string | null,
): Instr[] | AppError {
  const p = parsed;
  // JAL range: signed 21-bit offset, must be multiple of 2 → ±1 MiB
  const JAL_MAX = (1 << 20) - 1;
  const JAL_MIN = -(1 << 20);
  // Branch range: signed 13-bit offset → ±4 KiB
  const BR_MAX = (1 << 12) - 1;
  const BR_MIN = -(1 << 12);

  // hasOwnProperty, not `in`: labels is a plain object, so `in` would accept
  // inherited names like "toString".
  function undefinedLabel(target: string): AppError | null {
    if (Object.prototype.hasOwnProperty.call(labels, target)) return null;
    return new AppError(
      `Undefined label '${target}'`,
      `Instruction: ${raw}` + (label ? `, label: ${label}` : ""),
    );
  }

  function resolveJalOffset(target: string): Imm<21> | AppError {
    const undef = undefinedLabel(target);
    if (undef) return undef;
    const labelAddr = labels[target];
    const offset = labelAddr - addr;
    if (offset < JAL_MIN || offset > JAL_MAX)
      return new AppError(
        `Jump to '${target}' is out of JAL range (±1 MiB)`,
        `Instruction: ${raw}` + (label ? `, label: ${label}` : ""),
      );
    return offset as Imm<21>;
  }

  function resolveBranchOffset(target: string): Imm<13> | AppError {
    const undef = undefinedLabel(target);
    if (undef) return undef;
    const labelAddr = labels[target];
    const offset = labelAddr - addr;
    if (offset < BR_MIN || offset > BR_MAX)
      return new AppError(
        `Branch to '${target}' is out of range (±4 KiB)`,
        `Instruction: ${raw}` + (label ? `, label: ${label}` : ""),
      );
    return offset as Imm<13>;
  }

  switch (p.op) {
    case "ret":
      return [{ op: "jalr", rd: "zero", rs1: "ra", imm: 0 as Imm<12> }];
    case "nop":
      return [{ op: "addi", rd: "zero", rs1: "zero", imm: 0 as Imm<12> }];
    case "jalr": {
      const immVal = imm(p.imm, 12);
      if (immVal instanceof AppError) return immVal;
      return [{ op: "jalr", rd: p.rd, rs1: p.rs1, imm: immVal }];
    }
    case "call": {
      // Check first: any error below falls back to a far call (auipc + jalr).
      const undef = undefinedLabel(p.target);
      if (undef) return undef;
      const offset = resolveJalOffset(p.target);
      if (offset instanceof AppError) {
        // Offset too large for JAL: emit auipc + jalr
        const labelAddr = labels[p.target];
        const off = labelAddr - addr;
        const lo = ((off & 0xfff) << 20) >> 20;
        const hi = (off - lo) >> 12;
        return [
          { op: "auipc", rd: "ra", imm: hi as Imm<20> },
          { op: "jalr", rd: "ra", rs1: "ra", imm: lo as Imm<12> },
        ];
      }
      return [{ op: "jal", rd: "ra", target: offset }];
    }
    case "j": {
      const offset = resolveJalOffset(p.target);
      if (offset instanceof AppError) return offset;
      return [{ op: "jal", rd: "zero", target: offset }];
    }
    case "jal": {
      const offset = resolveJalOffset(p.target);
      if (offset instanceof AppError) return offset;
      return [{ op: "jal", rd: p.rd, target: offset }];
    }
    case "jr": {
      return [{ op: "jalr", rd: "zero", rs1: p.rs, imm: 0 as Imm<12> }];
    }
    case "li": {
      if (p.imm >= -2048 && p.imm <= 2047)
        return [{ op: "addi", rd: p.rd, rs1: "zero", imm: p.imm as Imm<12> }];
      const lo = (p.imm << 20) >> 20;
      const hi = (p.imm - lo) >> 12;
      return [
        { op: "lui", rd: p.rd, imm: hi as Imm<20> },
        { op: "addi", rd: p.rd, rs1: p.rd, imm: lo as Imm<12> },
      ];
    }
    case "lui": {
      const immVal = imm(p.imm, 20);
      if (immVal instanceof AppError) return immVal;
      return [{ op: "lui", rd: p.rd, imm: immVal }];
    }
    case "mv":
      return [{ op: "addi", rd: p.rd, rs1: p.rs1, imm: 0 as Imm<12> }];
    case "neg":
      return [{ op: "sub", rd: p.rd, rs1: "zero", rs2: p.rs1 }];
    case "addi":
    case "slli":
    case "srli":
    case "srai":
    case "andi":
    case "ori":
    case "xori": {
      const immVal = imm(p.imm, 12);
      if (immVal instanceof AppError) return immVal;
      return [{ op: p.op, rd: p.rd, rs1: p.rs1, imm: immVal }];
    }
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "rem":
    case "and":
    case "or":
    case "xor":
    case "sll":
    case "srl":
    case "sra":
      return [{ op: p.op, rd: p.rd, rs1: p.rs1, rs2: p.rs2 }];
    case "sw":
    case "sh":
    case "sb": {
      const offsetVal = imm(p.offset, 12);
      if (offsetVal instanceof AppError) return offsetVal;
      return [{ op: p.op, rs2: p.rs2, offset: offsetVal, rs1: p.rs1 }];
    }
    case "lw":
    case "lh":
    case "lb":
    case "lhu":
    case "lbu": {
      const offsetVal = imm(p.offset, 12);
      if (offsetVal instanceof AppError) return offsetVal;
      return [{ op: p.op, rd: p.rd, offset: offsetVal, rs1: p.rs1 }];
    }
    case "beq":
    case "bne":
    case "blt":
    case "bge":
    case "bltu":
    case "bgeu": {
      const offset = resolveBranchOffset(p.target);
      if (offset instanceof AppError) return offset;
      return [{ op: p.op, rs1: p.rs1, rs2: p.rs2, target: offset }];
    }
    // Operand-swapped pseudo-branches: bgt/ble/bgtu/bleu rs1, rs2, tgt
    // → real op with rs1/rs2 swapped (bgt a,b == blt b,a).
    case "bgt":
    case "ble":
    case "bgtu":
    case "bleu": {
      const offset = resolveBranchOffset(p.target);
      if (offset instanceof AppError) return offset;
      const real = { bgt: "blt", ble: "bge", bgtu: "bltu", bleu: "bgeu" }[p.op] as
        | "blt"
        | "bge"
        | "bltu"
        | "bgeu";
      return [{ op: real, rs1: p.rs2, rs2: p.rs1, target: offset }];
    }
    // Compare-to-zero pseudo-branches: op rs1, tgt → real op with one side "zero".
    case "beqz":
    case "bnez":
    case "bltz":
    case "bgez": {
      const offset = resolveBranchOffset(p.target);
      if (offset instanceof AppError) return offset;
      const real = { beqz: "beq", bnez: "bne", bltz: "blt", bgez: "bge" }[p.op] as
        | "beq"
        | "bne"
        | "blt"
        | "bge";
      return [{ op: real, rs1: p.rs1, rs2: "zero", target: offset }];
    }
    case "bgtz":
    case "blez": {
      const offset = resolveBranchOffset(p.target);
      if (offset instanceof AppError) return offset;
      const real = p.op === "bgtz" ? "blt" : "bge";
      return [{ op: real, rs1: "zero", rs2: p.rs1, target: offset }];
    }
    default:
      const _exhaustiveCheck: never = p;
      return _exhaustiveCheck;
  }
}

// ─── Assembler: two-pass ──────────────────────────────────────────────────

// Returns the worst-case number of concrete instructions for a parsed instr.
// Used in pass 1 to assign label addresses pessimistically.
function worstCaseSize(parsed: ParsedInstr): number {
  // call may collapse to 1 jal, but pessimistically assume 2 (auipc+jalr)
  if (parsed.op === "call") return 2;
  // li may expand to 2 (lui+addi) but that doesn't depend on labels
  // so it doesn't affect label addresses in a way that needs pessimism here;
  // we still count worst case to be safe
  if (parsed.op === "li") return 2;
  return 1;
}


export function assembleProgram(prog: Program): AssemblyResult | AppError {
  // ── Pass 1: parse all instructions and assign label addresses ──────────
  // Use worst-case sizes so label addresses are upper bounds.
  const parsedProgram = parseProgram(prog);
  if (parsedProgram instanceof AppError) return parsedProgram;
  const { lines: parsedLines, trailingLabels } = parsedProgram;

  // Pass 1: section-relative addresses from 0 (baseAddress not involved).
  // The first definition of a label wins.
  const labels: Record<string, number> = {};
  const define = (table: Record<string, number>, name: string, at: number) => {
    if (!Object.prototype.hasOwnProperty.call(table, name)) table[name] = at;
  };
  let addr = 0;
  for (const { labels: lineLabels, parsed } of parsedLines) {
    for (const name of lineLabels) define(labels, name, addr);
    addr += worstCaseSize(parsed) * 4;
  }
  // Trailing labels point just past the last instruction.
  for (const name of trailingLabels) define(labels, name, addr);

  // ── Pass 2: assemble with known labels, compute real section-relative addrs
  const sourceInstrs: SourceInstr[] = [];
  const addrToSourceIdx = new Map<number, number>();
  addr = 0;

  for (const { labels: lineLabels, raw, parsed } of parsedLines) {
    const assembled = assembleInstr(
      parsed, addr, labels, raw, lineLabels.length ? lineLabels.join(", ") : null,
    );
    if (assembled instanceof AppError) return assembled;
    const firstAddr = addr;
    const concretes: Instr[] = [];
    for (const spec of assembled) {
      addrToSourceIdx.set(addr, sourceInstrs.length);
      concretes.push(spec);
      addr += 4;
    }
    sourceInstrs.push({ labels: lineLabels, raw, parsed, concretes, firstAddr });
  }

  // Build real section-relative label addresses from actual pass-2 positions.
  const realLabels: Record<string, number> = {};
  for (const si of sourceInstrs) {
    for (const name of si.labels) define(realLabels, name, si.firstAddr);
  }
  for (const name of trailingLabels) define(realLabels, name, addr);

  // Fixup jump/branch targets using real section-relative addresses.
  // si.firstAddr is the address of concretes[0]; concretes[1] is at +4.
  const BRANCH_OPS = new Set([
    "beq", "bne", "blt", "bge", "bltu", "bgeu",
    "beqz", "bnez", "bltz", "bgez", "bgtz", "blez",
    "bgt", "ble", "bgtu", "bleu",
  ]);
  for (const si of sourceInstrs) {
    const p = si.parsed;
    if (p.op === "call" || p.op === "jal" || p.op === "j") {
      const realAddr = realLabels[p.target];
      if (realAddr == null) continue;
      if (si.concretes.length === 1) {
        const ci = si.concretes[0]!;
        if (ci.op === "jal")
          (ci as { target: Imm<21> }).target = (realAddr - si.firstAddr) as Imm<21>;
      } else if (si.concretes.length === 2) {
        const auipc = si.concretes[0]!;
        const jalr = si.concretes[1]!;
        if (auipc.op === "auipc" && jalr.op === "jalr") {
          const off = realAddr - si.firstAddr;
          const lo = ((off & 0xfff) << 20) >> 20;
          const hi = (off - lo) >> 12;
          (auipc as { imm: Imm<20> }).imm = hi as Imm<20>;
          (jalr as { imm: Imm<12> }).imm = lo as Imm<12>;
        }
      }
    } else if (BRANCH_OPS.has(p.op)) {
      const target = (p as { target: string }).target;
      const realAddr = realLabels[target];
      if (realAddr == null) continue;
      const ci = si.concretes[0]!;
      (ci as { target: Imm<13> }).target = (realAddr - si.firstAddr) as Imm<13>;
    }
  }

  // ── Load step: apply baseAddress to produce absolute addresses ────────────
  // PC-relative offsets (jal.target, branch.target) are untouched —
  // baseAddress cancels in (base + sectionTarget) - (base + sectionInstr).
  for (const si of sourceInstrs) {
    (si as { firstAddr: number }).firstAddr += prog.baseAddress;
  }
  const absAddrToSourceIdx = new Map<number, number>();
  for (const [k, v] of addrToSourceIdx) {
    absAddrToSourceIdx.set(k + prog.baseAddress, v);
  }
  for (const lbl of Object.keys(realLabels)) {
    realLabels[lbl] += prog.baseAddress;
  }

  return {
    sourceInstrs,
    addrToSourceIdx: absAddrToSourceIdx,
    labels: realLabels,
    trailingLabels,
  };
}

// ─── Concrete instruction serializer ──────────────────────────────────────
export function fmtConcreteRel(c: Instr, addr: number): string {
  if (c.op === "jalr") return `jalr ${c.rd}, ${c.imm}(${c.rs1})`;
  if (c.op === "jal")
    return `jal ${c.rd}, ${c.target >= 0 ? "+" : ""}${c.target}`;
  if (c.op === "lui" || c.op === "auipc") return `${c.op} ${c.rd}, ${c.imm}`;
  if (
    (
      ["addi", "andi", "ori", "xori", "slli", "srli", "srai"] as string[]
    ).includes(c.op)
  ) {
    const ci = c as Instr & { rd: string; rs1: string; imm: number };
    return `${ci.op} ${ci.rd}, ${ci.rs1}, ${ci.imm}`;
  }
  if (
    (
      [
        "add",
        "sub",
        "mul",
        "div",
        "rem",
        "and",
        "or",
        "xor",
        "sll",
        "srl",
        "sra",
      ] as string[]
    ).includes(c.op)
  ) {
    const ci = c as Instr & { rd: string; rs1: string; rs2: string };
    return `${ci.op} ${ci.rd}, ${ci.rs1}, ${ci.rs2}`;
  }
  if (c.op === "sw" || c.op === "sb" || c.op === "sh")
    return `${c.op} ${c.rs2}, ${c.offset}(${c.rs1})`;
  if ((["lw", "lb", "lh", "lbu", "lhu"] as string[]).includes(c.op)) {
    const ci = c as Instr & { rd: string; offset: number; rs1: string };
    return `${ci.op} ${ci.rd}, ${ci.offset}(${ci.rs1})`;
  }
  if (
    (["beq", "bne", "blt", "bge", "bltu", "bgeu"] as string[]).includes(c.op)
  ) {
    const ci = c as Instr & { rs1: string; rs2: string; target: number };
    return `${ci.op} ${ci.rs1}, ${ci.rs2}, ${ci.target >= 0 ? "+" : ""}${ci.target}`;
  }
  return c.op;
}
