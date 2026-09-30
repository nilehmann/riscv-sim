import type { ParsedInstr, Reg } from "./types";
import { isReg } from "./types";
import { AppError } from "../../types";

// ─── Register parser ──────────────────────────────────────────────────────────

export function parseReg(s: string | undefined, ctx: string): Reg | AppError {
  if (s === undefined)
    return new AppError(`Missing register operand`, `Instruction: ${ctx}`);
  const name = s === "fp" ? "s0" : s;
  if (isReg(name)) return name;
  return new AppError(
    `'${s}' is not a valid register name`,
    "Valid registers: x0–x31 and their aliases (zero, ra, sp, a0–a7, s0–s11, t0–t6, gp, tp)",
  );
}

// ─── Immediate parser ─────────────────────────────────────────────────────────

function parseImm(s: string, ctx: string): number | AppError {
  const v = Number(s);
  if (isNaN(v))
    return new AppError(`'${s}' is not a valid integer`, `Instruction: ${ctx}`);
  return v;
}

// ─── Memory operand parser: offset(reg) ───────────────────────────────────────

function parseMem(
  s: string,
  ctx: string,
): { offset: number; rs1: Reg } | AppError {
  const m = s.match(/^(-?\d+)\((\w+)\)$/);
  if (!m)
    return new AppError(
      `'${s}' is not a valid memory operand`,
      `Expected offset(reg), e.g. -4(sp). Instruction: ${ctx}`,
    );
  const rs1 = parseReg(m[2], ctx);
  if (rs1 instanceof AppError) return rs1;
  return { offset: Number(m[1]), rs1 };
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function stripComment(line: string): string {
  const h = line.indexOf("#");
  return h === -1 ? line : line.slice(0, h);
}

// Splits a raw assembly line into an opcode and a list of argument strings.
// Inline comments (# or //) are stripped. Whitespace is normalised.
function tokenize(raw: string): { op: string; args: string[] } {
  const line = stripComment(raw).trim();
  if (!line) return { op: "", args: [] };
  const ws = line.search(/\s/);
  const op = ws === -1 ? line : line.slice(0, ws);
  const rest = ws === -1 ? "" : line.slice(ws + 1).trim();
  const args = rest
    ? rest
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  return { op, args };
}

// ─── Schema ───────────────────────────────────────────────────────────────────

type RegField = "rd" | "rs1" | "rs2" | "rs";
type OperandSpec =
  | { kind: "reg"; field: RegField }
  | { kind: "imm" }
  | { kind: "label" }
  | { kind: "mem"; offsetField: "imm" | "offset" };

const r = (field: RegField): OperandSpec => ({ kind: "reg", field });
const IMM: OperandSpec = { kind: "imm" };
const LABEL: OperandSpec = { kind: "label" };
const MEM = (offsetField: "imm" | "offset"): OperandSpec => ({
  kind: "mem",
  offsetField,
});

// Each opcode maps to the ordered list of operand specs it expects.
// jal is variadic and handled separately in parseInstr.
const SCHEMA: Record<string, OperandSpec[]> = {
  // Zero-operand pseudo-ops
  ret: [],
  nop: [],
  // Single-register pseudo-ops
  jr: [r("rs")],
  // Two-operand pseudo-ops
  li: [r("rd"), IMM],
  lui: [r("rd"), IMM],
  mv: [r("rd"), r("rs1")],
  neg: [r("rd"), r("rs1")],
  // Single-label pseudo-ops
  call: [LABEL],
  j: [LABEL],
  // jalr: rd, offset(rs1)  — mem offsetField mapped to ParsedInstr.imm
  jalr: [r("rd"), MEM("imm")],
  // I-type
  addi: [r("rd"), r("rs1"), IMM],
  slli: [r("rd"), r("rs1"), IMM],
  srli: [r("rd"), r("rs1"), IMM],
  srai: [r("rd"), r("rs1"), IMM],
  andi: [r("rd"), r("rs1"), IMM],
  ori: [r("rd"), r("rs1"), IMM],
  xori: [r("rd"), r("rs1"), IMM],
  // R-type
  add: [r("rd"), r("rs1"), r("rs2")],
  sub: [r("rd"), r("rs1"), r("rs2")],
  mul: [r("rd"), r("rs1"), r("rs2")],
  div: [r("rd"), r("rs1"), r("rs2")],
  rem: [r("rd"), r("rs1"), r("rs2")],
  and: [r("rd"), r("rs1"), r("rs2")],
  or: [r("rd"), r("rs1"), r("rs2")],
  xor: [r("rd"), r("rs1"), r("rs2")],
  sll: [r("rd"), r("rs1"), r("rs2")],
  srl: [r("rd"), r("rs1"), r("rs2")],
  sra: [r("rd"), r("rs1"), r("rs2")],
  // Loads: rd, offset(rs1)
  lw: [r("rd"), MEM("offset")],
  lh: [r("rd"), MEM("offset")],
  lb: [r("rd"), MEM("offset")],
  lhu: [r("rd"), MEM("offset")],
  lbu: [r("rd"), MEM("offset")],
  // Stores: rs2, offset(rs1)
  sw: [r("rs2"), MEM("offset")],
  sh: [r("rs2"), MEM("offset")],
  sb: [r("rs2"), MEM("offset")],
  // Branches: rs1, rs2, label
  beq: [r("rs1"), r("rs2"), LABEL],
  bne: [r("rs1"), r("rs2"), LABEL],
  blt: [r("rs1"), r("rs2"), LABEL],
  bge: [r("rs1"), r("rs2"), LABEL],
  bltu: [r("rs1"), r("rs2"), LABEL],
  bgeu: [r("rs1"), r("rs2"), LABEL],
  // Branch pseudo-ops, compare-to-zero: rs1, label
  beqz: [r("rs1"), LABEL],
  bnez: [r("rs1"), LABEL],
  bltz: [r("rs1"), LABEL],
  bgez: [r("rs1"), LABEL],
  bgtz: [r("rs1"), LABEL],
  blez: [r("rs1"), LABEL],
  // Branch pseudo-ops, operand-swapped: rs1, rs2, label
  bgt: [r("rs1"), r("rs2"), LABEL],
  ble: [r("rs1"), r("rs2"), LABEL],
  bgtu: [r("rs1"), r("rs2"), LABEL],
  bleu: [r("rs1"), r("rs2"), LABEL],
};

// ─── Generic operand builder ──────────────────────────────────────────────────

function applySchema(
  op: string,
  specs: OperandSpec[],
  args: string[],
  raw: string,
): ParsedInstr | AppError {
  if (args.length !== specs.length) {
    const exp = specs.length;
    return new AppError(
      `'${op}' expects ${exp} operand${exp !== 1 ? "s" : ""}, got ${args.length}`,
      `Instruction: ${raw}`,
    );
  }
  const obj: Record<string, unknown> = { op };
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const arg = args[i]!;
    switch (spec.kind) {
      case "reg": {
        const v = parseReg(arg, raw);
        if (v instanceof AppError) return v;
        obj[spec.field] = v;
        break;
      }
      case "imm": {
        const v = parseImm(arg, raw);
        if (v instanceof AppError) return v;
        obj["imm"] = v;
        break;
      }
      case "label":
        obj["target"] = arg;
        break;
      case "mem": {
        const v = parseMem(arg, raw);
        if (v instanceof AppError) return v;
        obj[spec.offsetField] = v.offset;
        obj["rs1"] = v.rs1;
        break;
      }
    }
  }
  return obj as unknown as ParsedInstr;
}

// ─── Main parser entry point ──────────────────────────────────────────────────

export function parseInstr(raw: string): ParsedInstr | AppError {
  const { op, args } = tokenize(raw);

  // jal [rd,] target — rd defaults to ra when omitted
  if (op === "jal") {
    if (args.length === 1) return { op: "jal", rd: "ra", target: args[0]! };
    if (args.length === 2) {
      const rd = parseReg(args[0], raw);
      if (rd instanceof AppError) return rd;
      return { op: "jal", rd, target: args[1]! };
    }
    return new AppError(
      `'jal' expects 1 or 2 operands, got ${args.length}`,
      `Instruction: ${raw}`,
    );
  }

  const specs = SCHEMA[op];
  if (specs === undefined)
    return new AppError(`Unknown instruction: '${op || raw}'`);

  return applySchema(op, specs, args, raw);
}
