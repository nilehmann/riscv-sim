import type {
    Program,
    ParsedInstr,
    ConcreteSpec,
    AssemblyResult,
    SourceInstr,
} from "./types";
import { ParseError, RangeError } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────
export const hx = (v: number): string =>
    "0x" + (v >>> 0).toString(16).toUpperCase().padStart(4, "0");

// ─── Instruction parser ───────────────────────────────────────────────────
export function parseInstr(raw: string): ParsedInstr | ParseError {
    const s = raw.trim().replace(/\s+/g, " ");
    const sp = s.indexOf(" ");
    const op = sp === -1 ? s : s.slice(0, sp);
    const argStr = sp === -1 ? "" : s.slice(sp + 1);
    const args = argStr ? argStr.split(",").map((a) => a.trim()) : [];

    if (op === "ret") return { op: "ret" };
    if (op === "jalr") {
        const mem = args[1] && args[1].match(/^(-?\d+)\((\w+)\)$/);
        if (mem) return { op: "jalr", rd: args[0], rs1: mem[2], imm: Number(mem[1]) };
        return new ParseError(raw, "");
    }
    if (op === "call") return { op: "call", target: args[0] };
    if (op === "j") return { op: "j", target: args[0] };
    if (op === "jal")
        return {
            op: "jal",
            rd: args.length > 1 ? args[0] : "ra",
            target: args[args.length - 1],
        };
    if (op === "li" || op === "lui")
        return { op, rd: args[0], imm: Number(args[1]) };
    if (op === "mv") return { op: "mv", rd: args[0], rs1: args[1] };
    if (op === "neg") return { op: "neg", rd: args[0], rs1: args[1] };
    if (op === "nop") return { op: "nop" };
    if (
        op === "addi" ||
        op === "slli" ||
        op === "srli" ||
        op === "srai" ||
        op === "andi" ||
        op === "ori" ||
        op === "xori"
    ) {
        return {
            op,
            rd: args[0],
            rs1: args[1],
            imm: Number(args[2]),
        };
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
        ).includes(op)
    ) {
        return {
            op: op as
                | "add"
                | "sub"
                | "mul"
                | "div"
                | "rem"
                | "and"
                | "or"
                | "xor"
                | "sll"
                | "srl"
                | "sra",
            rd: args[0],
            rs1: args[1],
            rs2: args[2],
        };
    }

    // sw/lw/sb/lb/sh/lh: reg, offset(base)
    if (
        (
            ["sw", "lw", "sb", "lb", "sh", "lh", "lbu", "lhu"] as string[]
        ).includes(op)
    ) {
        const mem = args[1] && args[1].match(/^(-?\d+)\((\w+)\)$/);
        if (mem) {
            if (op === "sw" || op === "sb" || op === "sh") {
                return {
                    op,
                    rs2: args[0],
                    offset: Number(mem[1]),
                    rs1: mem[2],
                };
            }
            return {
                op: op as "lw" | "lh" | "lb" | "lhu" | "lbu",
                rd: args[0],
                offset: Number(mem[1]),
                rs1: mem[2],
            };
        }
    }

    // Branches: rs1, rs2, label
    if (
        (["beq", "bne", "blt", "bge", "bltu", "bgeu"] as string[]).includes(op)
    ) {
        return {
            op: op as "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu",
            rs1: args[0],
            rs2: args[1],
            target: args[2],
        };
    }

    return new ParseError(s, "");
}

// ─── Pseudo-instruction expander ─────────────────────────────────────────
function assembleInstr(
    parsed: ParsedInstr,
    addr: number,
    labels: Record<string, number>,
    raw: string,
    fn: string,
): ConcreteSpec[] | RangeError {
    const p = parsed;
    // JAL range: signed 21-bit offset, must be multiple of 2 → ±1 MiB
    const JAL_MAX = (1 << 20) - 1;
    const JAL_MIN = -(1 << 20);
    // Branch range: signed 13-bit offset → ±4 KiB
    const BR_MAX = (1 << 12) - 1;
    const BR_MIN = -(1 << 12);

    function resolveJalOffset(target: string): number | RangeError {
        const labelAddr = labels[target];
        const offset = labelAddr - addr;
        if (offset < JAL_MIN || offset > JAL_MAX)
            return new RangeError(raw, fn);
        return offset;
    }

    function resolveBranchOffset(target: string): number | RangeError {
        const labelAddr = labels[target];
        const offset = labelAddr - addr;
        if (offset < BR_MIN || offset > BR_MAX) return new RangeError(raw, fn);
        return offset;
    }

    switch (p.op) {
        case "ret":
            return [{ op: "jalr", rd: "zero", rs1: "ra", imm: 0 }];
        case "nop":
            return [{ op: "addi", rd: "zero", rs1: "zero", imm: 0 }];
        case "jalr":
            return [{ op: "jalr", rd: p.rd, rs1: p.rs1, imm: p.imm }];
        case "call": {
            const offset = resolveJalOffset(p.target);
            if (offset instanceof RangeError) {
                // Offset too large for JAL: emit auipc + jalr
                const labelAddr = labels[p.target];
                const off = labelAddr - addr;
                const lo = ((off & 0xfff) << 20) >> 20;
                const hi = (off - lo) >> 12;
                return [
                    { op: "auipc", rd: "ra", imm: hi },
                    { op: "jalr", rd: "ra", rs1: "ra", imm: lo },
                ];
            }
            return [{ op: "jal", rd: "ra", target: offset }];
        }
        case "j": {
            const offset = resolveJalOffset(p.target);
            if (offset instanceof RangeError) return offset;
            return [{ op: "jal", rd: "zero", target: offset }];
        }
        case "jal": {
            const offset = resolveJalOffset(p.target);
            if (offset instanceof RangeError) return offset;
            return [{ op: "jal", rd: p.rd, target: offset }];
        }
        case "li": {
            if (p.imm >= -2048 && p.imm <= 2047)
                return [{ op: "addi", rd: p.rd, rs1: "zero", imm: p.imm }];
            const lo = (p.imm << 20) >> 20;
            const hi = (p.imm - lo) >> 12;
            return [
                { op: "lui", rd: p.rd, imm: hi },
                { op: "addi", rd: p.rd, rs1: p.rd, imm: lo },
            ];
        }
        case "lui":
            return [{ op: "lui", rd: p.rd, imm: p.imm }];
        case "mv":
            return [{ op: "addi", rd: p.rd, rs1: p.rs1, imm: 0 }];
        case "neg":
            return [{ op: "sub", rd: p.rd, rs1: "zero", rs2: p.rs1 }];
        case "addi":
        case "slli":
        case "srli":
        case "srai":
        case "andi":
        case "ori":
        case "xori":
            return [{ op: p.op, rd: p.rd, rs1: p.rs1, imm: p.imm }];
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
        case "sb":
            return [{ op: p.op, rs2: p.rs2, offset: p.offset, rs1: p.rs1 }];
        case "lw":
        case "lh":
        case "lb":
        case "lhu":
        case "lbu":
            return [{ op: p.op, rd: p.rd, offset: p.offset, rs1: p.rs1 }];
        case "beq":
        case "bne":
        case "blt":
        case "bge":
        case "bltu":
        case "bgeu": {
            const offset = resolveBranchOffset(p.target);
            if (offset instanceof RangeError) return offset;
            return [{ op: p.op, rs1: p.rs1, rs2: p.rs2, target: offset }];
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

type ParsedLine = { fn: string; raw: string; parsed: ParsedInstr };

// Parses all instruction lines in the program and returns a flat list of
// ParsedLine records, preserving the function each line belongs to.
// Returns a ParseError on the first line that cannot be parsed.
function parseProgram(prog: Program): ParsedLine[] | ParseError {
    const parsedLines: ParsedLine[] = [];
    for (const [fn, lines] of Object.entries(prog.functions)) {
        for (const line of lines) {
            const parsed = parseInstr(line);
            if (parsed instanceof ParseError)
                return new ParseError(parsed.raw, fn);
            parsedLines.push({ fn, raw: line.trim(), parsed });
        }
    }
    return parsedLines;
}

export function assembleProgram(
    prog: Program,
): AssemblyResult | ParseError | RangeError {
    // ── Pass 1: parse all instructions and assign label addresses ──────────
    // Use worst-case sizes so label addresses are upper bounds.
    const parsedLines = parseProgram(prog);
    if (parsedLines instanceof ParseError) return parsedLines;

    // Pass 1: section-relative addresses from 0 (baseAddress not involved).
    const labels: Record<string, number> = {};
    let addr = 0;
    let prevFn = "";
    for (const { fn, parsed } of parsedLines) {
        if (fn !== prevFn) { labels[fn] = addr; prevFn = fn; }
        addr += worstCaseSize(parsed) * 4;
    }

    // ── Pass 2: assemble with known labels, compute real section-relative addrs
    const sourceInstrs: SourceInstr[] = [];
    const addrToSourceIdx = new Map<number, number>();
    addr = 0;

    for (const { fn, raw, parsed } of parsedLines) {
        const assembled = assembleInstr(parsed, addr, labels, raw, fn);
        if (assembled instanceof RangeError) return assembled;
        const firstAddr = addr;
        const concretes: ConcreteSpec[] = [];
        for (const spec of assembled) {
            addrToSourceIdx.set(addr, sourceInstrs.length);
            concretes.push(spec);
            addr += 4;
        }
        sourceInstrs.push({ fn, raw, parsed, concretes, firstAddr });
    }

    // Build real section-relative label addresses from actual pass-2 positions.
    const realLabels: Record<string, number> = {};
    for (const si of sourceInstrs) {
        if (!(si.fn in realLabels)) realLabels[si.fn] = si.firstAddr;
    }

    // Fixup jump/branch targets using real section-relative addresses.
    // si.firstAddr is the address of concretes[0]; concretes[1] is at +4.
    const BRANCH_OPS = new Set([
        "beq", "bne", "blt", "bge", "bltu", "bgeu",
    ]);
    for (const si of sourceInstrs) {
        const p = si.parsed;
        if (p.op === "call" || p.op === "jal" || p.op === "j") {
            const realAddr = realLabels[p.target];
            if (realAddr == null) continue;
            if (si.concretes.length === 1) {
                const ci = si.concretes[0]!;
                if (ci.op === "jal")
                    (ci as { target: number }).target = realAddr - si.firstAddr;
            } else if (si.concretes.length === 2) {
                const auipc = si.concretes[0]!;
                const jalr = si.concretes[1]!;
                if (auipc.op === "auipc" && jalr.op === "jalr") {
                    const off = realAddr - si.firstAddr;
                    const lo = ((off & 0xfff) << 20) >> 20;
                    const hi = (off - lo) >> 12;
                    (auipc as { imm: number }).imm = hi;
                    (jalr as { imm: number }).imm = lo;
                }
            }
        } else if (BRANCH_OPS.has(p.op)) {
            const target = (p as { target: string }).target;
            const realAddr = realLabels[target];
            if (realAddr == null) continue;
            const ci = si.concretes[0]!;
            (ci as { target: number }).target = realAddr - si.firstAddr;
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
    for (const fn of Object.keys(realLabels)) {
        realLabels[fn] += prog.baseAddress;
    }

    return { sourceInstrs, addrToSourceIdx: absAddrToSourceIdx, labels: realLabels };
}

// ─── Concrete instruction serializer ──────────────────────────────────────
export function fmtConcrete(c: ConcreteSpec, addr: number): string {
    if (c.op === "jalr") return `jalr ${c.rd}, ${c.imm}(${c.rs1})`;
    if (c.op === "jal") return `jal ${c.rd}, ${hx(addr + c.target)}`;
    if (c.op === "lui" || c.op === "auipc") return `${c.op} ${c.rd}, ${c.imm}`;
    if (
        (
            ["addi", "andi", "ori", "xori", "slli", "srli", "srai"] as string[]
        ).includes(c.op)
    ) {
        const ci = c as ConcreteSpec & { rd: string; rs1: string; imm: number };
        return `${ci.op} ${ci.rd}, ${ci.rs1}, ${ci.imm}`;
    }
    if (
        (
            [
                "add", "sub", "mul", "div", "rem",
                "and", "or", "xor", "sll", "srl", "sra",
            ] as string[]
        ).includes(c.op)
    ) {
        const ci = c as ConcreteSpec & { rd: string; rs1: string; rs2: string };
        return `${ci.op} ${ci.rd}, ${ci.rs1}, ${ci.rs2}`;
    }
    if (c.op === "sw" || c.op === "sb" || c.op === "sh")
        return `${c.op} ${c.rs2}, ${c.offset}(${c.rs1})`;
    if ((["lw", "lb", "lh", "lbu", "lhu"] as string[]).includes(c.op)) {
        const ci = c as ConcreteSpec & { rd: string; offset: number; rs1: string };
        return `${ci.op} ${ci.rd}, ${ci.offset}(${ci.rs1})`;
    }
    if (
        (["beq", "bne", "blt", "bge", "bltu", "bgeu"] as string[]).includes(c.op)
    ) {
        const ci = c as ConcreteSpec & { rs1: string; rs2: string; target: number };
        return `${ci.op} ${ci.rs1}, ${ci.rs2}, ${hx(addr + ci.target)}`;
    }
    return c.op;
}
