import type { ParsedInstr, Instr, Imm } from "./types";
import { imm } from "./types";
import type { ExpandCtx } from "../types";
import { AppError } from "../../types";

// ─── Pseudo-instruction expander ─────────────────────────────────────────
export function expand(p: ParsedInstr, ctx: ExpandCtx): Instr[] | AppError {
  const { addr, labels, raw } = ctx;
  const label = ctx.lineLabels.length ? ctx.lineLabels.join(", ") : null;
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

// Returns the worst-case number of concrete instructions for a parsed instr.
// Used in pass 1 to assign label addresses pessimistically.
export function maxInstrs(parsed: ParsedInstr): number {
  // call may collapse to 1 jal, but pessimistically assume 2 (auipc+jalr)
  if (parsed.op === "call") return 2;
  // li may expand to 2 (lui+addi) but that doesn't depend on labels
  // so it doesn't affect label addresses in a way that needs pessimism here;
  // we still count worst case to be safe
  if (parsed.op === "li") return 2;
  return 1;
}
