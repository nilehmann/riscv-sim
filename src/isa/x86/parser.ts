import type { MemOp, Operand, Parsed, Size } from "./types";
import { REGS } from "./types";
import { AppError } from "../../types";

// Parses GAS/objdump Intel syntax: `mov DWORD PTR [rbp-4], edi`.

const SIZE_KEYWORDS: Record<string, Size> = { byte: 1, word: 2, dword: 4, qword: 8 };
const NUMBER = /^[+-]?(0x[0-9a-f]+|\d+)$/i;
const LABEL = /^[A-Za-z_.$][\w.$]*$/;

function stripComment(line: string): string {
  const h = line.indexOf("#");
  return h === -1 ? line : line.slice(0, h);
}

function parseNumber(s: string): bigint {
  const neg = s.startsWith("-");
  const v = BigInt(s.replace(/^[+-]/, ""));
  return neg ? -v : v;
}

// ─── Memory operand: [base + index*scale ± disp] ──────────────────────────

function parseMem(inner: string, prefix: string, size: Size | null, ctx: string): MemOp | AppError {
  const bad = (msg: string) => new AppError(msg, `Instruction: ${ctx}`);
  let base: string | null = null;
  let index: string | null = null;
  let scale: 1 | 2 | 4 | 8 = 1;
  let disp = 0n;

  // gcc also writes the displacement in front: `-4[rbp]`.
  if (prefix) {
    if (!NUMBER.test(prefix)) return bad(`'${prefix}' is not a valid displacement`);
    disp += parseNumber(prefix);
  }

  // Split into signed terms: "rax+rdx*4-8" → +rax, +rdx*4, -8
  const terms = inner.replace(/\s+/g, "").match(/[+-]?[^+-]+/g);
  if (!terms) return bad(`Empty memory operand`);
  for (const term of terms) {
    const negative = term.startsWith("-");
    const body = term.replace(/^[+-]/, "").toLowerCase();
    if (NUMBER.test(body)) {
      disp += negative ? -parseNumber(body) : parseNumber(body);
      continue;
    }
    // reg, reg*scale or scale*reg
    const factors = body.split("*");
    const regName = factors.find((f) => REGS[f]);
    const scaleText = factors.find((f) => f !== regName);
    if (!regName || factors.length > 2 || negative)
      return bad(`'${term}' is not valid inside a memory operand`);
    if (REGS[regName]!.size !== 8)
      return bad(`'${regName}' cannot be used in an address: use a 64-bit register`);
    if (scaleText !== undefined) {
      if (!["1", "2", "4", "8"].includes(scaleText))
        return bad(`Scale must be 1, 2, 4 or 8, not '${scaleText}'`);
      if (index) return bad(`A memory operand can only have one index register`);
      index = regName;
      scale = Number(scaleText) as 1 | 2 | 4 | 8;
    } else if (!base) {
      base = regName;
    } else if (!index) {
      index = regName;
    } else {
      return bad(`A memory operand can have at most a base and an index register`);
    }
  }

  // rsp cannot be an index; with no scale the two registers can swap roles.
  if (index === "rsp") {
    if (scale !== 1 || base === "rsp") return bad(`rsp cannot be used as an index register`);
    [base, index] = [index, base];
  }
  if (disp < -(2n ** 31n) || disp >= 2n ** 31n)
    return bad(`Displacement ${disp} does not fit in 32 bits`);
  return { kind: "mem", size, base, index, scale, disp: Number(disp) };
}

// ─── Operand ──────────────────────────────────────────────────────────────

function parseOperand(text: string, ctx: string): Operand | AppError {
  let t = text.trim();
  let size: Size | null = null;
  const sz = t.match(/^(byte|word|dword|qword)\s+ptr\s+(.*)$/i);
  if (sz) {
    size = SIZE_KEYWORDS[sz[1]!.toLowerCase()]!;
    t = sz[2]!.trim();
  }

  const mem = t.match(/^([^\[\]]*)\[([^\[\]]*)\]$/);
  if (mem) return parseMem(mem[2]!, mem[1]!.trim(), size, ctx);
  if (size !== null)
    return new AppError(`Expected a memory operand like [rbp-4] after PTR`, `Instruction: ${ctx}`);

  const lower = t.toLowerCase();
  if (REGS[lower]) return { kind: "reg", name: lower };
  if (NUMBER.test(t)) return { kind: "imm", value: parseNumber(t), text: t };
  if (LABEL.test(t)) return { kind: "label", name: t };
  return new AppError(`'${t}' is not a valid operand`, `Instruction: ${ctx}`);
}

// ─── Instruction ──────────────────────────────────────────────────────────

export function parseLine(raw: string): Parsed | AppError {
  const line = stripComment(raw).trim();
  const ws = line.search(/\s/);
  const op = (ws === -1 ? line : line.slice(0, ws)).toLowerCase();
  const rest = ws === -1 ? "" : line.slice(ws + 1).trim();
  if (!op) return new AppError(`Unknown instruction: '${raw}'`);

  const ops: Operand[] = [];
  if (rest) {
    for (const part of rest.split(",")) {
      const operand = parseOperand(part, raw);
      if (operand instanceof AppError) return operand;
      ops.push(operand);
    }
  }
  return { op, ops };
}
