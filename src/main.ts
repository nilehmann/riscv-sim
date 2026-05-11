import type {
    Program,
    ParsedInstr,
    ConcreteSpec,
    SourceInstr,
    AssemblyResult,
    Step,
    DisplayReg,
    Token,
    TokenKind,
} from "./types";
import { ParseError, RangeError } from "./types";

// ─── Programs ──────────────────────────────────────────────────────────────
// To add a new program: append an entry to this array.
// functions: object mapping name → array of instruction strings (in order).
// The first function listed determines the lowest address block.
const PROGRAMS: Program[] = [
    {
        name: "baz -> foo",
        cCode: `int foo(int x) {\n    return x + 1;\n}\n\nint baz(int y) {\n    return foo(1) + y;\n}`,
        entryPoint: "baz",
        initialRegs: { sp: 0x1000, ra: 0x8050, a0: 3, s0: 0x54 },
        baseAddress: 0x8000,
        functions: {
            foo: ["addi a0, a0, 1", "ret"],
            baz: [
                "addi sp, sp, -16",
                "sw   ra, 12(sp)",
                "sw   s0, 8(sp)",
                "mv   s0, a0",
                "li   a0, 1",
                "call foo",
                "add  a0, a0, s0",
                "lw   ra, 12(sp)",
                "lw   s0, 8(sp)",
                "addi sp, sp, 16",
                "ret",
            ],
        },
    },
    {
        name: "bar -> foo -> baz",
        entryPoint: "bar",
        initialRegs: { sp: 0x1000, ra: 0x9000, a0: 3, s0: 0x54 },
        baseAddress: 0x8000,
        functions: {
            baz: ["add     a0,a0,a1", "ret"],
            foo: [
                "addi    sp,sp,-16",
                "sw      ra,12(sp)",
                "li      a1,0",
                "call    baz",
                "addi    a0,a0,1",
                "lw      ra,12(sp)",
                "addi    sp,sp,16",
                "ret",
            ],
            bar: [
                "addi    sp,sp,-16",
                "sw      ra,12(sp)",
                "sw      s0,8(sp)",
                "mv      s0,a0",
                "li      a0,-1",
                "call    foo",
                "add     a0,a0,s0",
                "lw      ra,12(sp)",
                "lw      s0,8(sp)",
                "addi    sp,sp,16",
                "ret",
            ],
        },
    },
    {
        name: "load big immediate",
        entryPoint: "foo",
        initialRegs: { sp: 0x1000, ra: 0x9000 },
        baseAddress: 0x8000,
        functions: {
            foo: ["li a0, 4097", "ret"],
        },
    },
    {
        name: "forward call (bar → baz)",
        entryPoint: "bar",
        initialRegs: { sp: 0x1000, ra: 0x9000, a0: 5 },
        baseAddress: 0x8000,
        functions: {
            bar: [
                "addi sp, sp, -16",
                "sw   ra, 12(sp)",
                "call baz",
                "lw   ra, 12(sp)",
                "addi sp, sp, 16",
                "ret",
            ],
            baz: ["addi a0, a0, 1", "ret"],
        },
    },
    {
        name: "función hoja simple",
        entryPoint: "double",
        initialRegs: { sp: 0x1000, ra: 0x9000, a0: 5 },
        baseAddress: 0x8000,
        cCode: `int foo(int x) {\n  return x + 1;\n}`,
        functions: {
            double: ["addi  a0, a0, 1", "ret"],
        },
    },
];

// ─── Constants ────────────────────────────────────────────────────────────
const REG_SET = new Set([
    "zero",
    "ra",
    "sp",
    "gp",
    "tp",
    "fp",
    "a0",
    "a1",
    "a2",
    "a3",
    "a4",
    "a5",
    "a6",
    "a7",
    "s0",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s11",
    "t0",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
]);
const ALL_REGS = [
    "zero",
    "ra",
    "sp",
    "gp",
    "tp",
    "a0",
    "a1",
    "a2",
    "a3",
    "a4",
    "a5",
    "a6",
    "a7",
    "s0",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s11",
    "t0",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
    "fp",
];
const REG_META = {
    zero: { desc: "constante cero" },
    ra: { desc: "dirección retorno" },
    sp: { desc: "stack pointer" },
    gp: { desc: "global pointer" },
    tp: { desc: "thread pointer" },
    fp: { desc: "frame pointer" },
    a0: { desc: "arg / retorno" },
    a1: { desc: "arg 2" },
    a2: { desc: "arg 3" },
    a3: { desc: "arg 4" },
    a4: { desc: "arg 5" },
    a5: { desc: "arg 6" },
    a6: { desc: "arg 7" },
    a7: { desc: "arg 8" },
    s0: { desc: "callee-saved" },
    s1: { desc: "callee-saved" },
    s2: { desc: "callee-saved" },
    s3: { desc: "callee-saved" },
    s4: { desc: "callee-saved" },
    s5: { desc: "callee-saved" },
    s6: { desc: "callee-saved" },
    s7: { desc: "callee-saved" },
    s8: { desc: "callee-saved" },
    s9: { desc: "callee-saved" },
    s10: { desc: "callee-saved" },
    s11: { desc: "callee-saved" },
    t0: { desc: "temporal" },
    t1: { desc: "temporal" },
    t2: { desc: "temporal" },
    t3: { desc: "temporal" },
    t4: { desc: "temporal" },
    t5: { desc: "temporal" },
    t6: { desc: "temporal" },
};

// Colors cycling per frame depth (index 0 = outermost active frame)
const FRAME_COLORS = [
    "var(--green-dim)",
    "var(--blue-dim)",
    "var(--orange-dim)",
    "var(--purple-dim)",
];
const GHOST_ROWS = 3;
const OFFSET_MAX = 64; // only show sp±N labels within this range

// ─── Helpers ──────────────────────────────────────────────────────────────
const hx = (v: number): string =>
    "0x" + (v >>> 0).toString(16).toUpperCase().padStart(4, "0");

// ─── Instruction parser ───────────────────────────────────────────────────
function parseInstr(raw: string): ParsedInstr | ParseError {
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

function assembleProgram(
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

// ─── Syntax highlighter ───────────────────────────────────────────────────
function highlightInstr(raw: string): string {
    const s = raw.trim();
    const sp = s.indexOf(" ");
    const op = sp === -1 ? s : s.slice(0, sp);
    const rest = sp === -1 ? "" : s.slice(sp + 1);

    let html = `<span class="kw">${op}</span>`;
    if (!rest) return html;

    const tokenHtml = (tok: string): string => {
        const t = tok.trim();
        const memM = t.match(/^(-?\d+)\((\w+)\)$/);
        if (memM)
            return `<span class="imm">${memM[1]}</span>(<span class="reg">${memM[2]}</span>)`;
        if (REG_SET.has(t)) return `<span class="reg">${t}</span>`;
        if (/^-?\d+$/.test(t)) return `<span class="imm">${t}</span>`;
        return `<span class="fn">${t}</span>`;
    };

    const toks = rest.split(",");
    html +=
        " " +
        toks
            .map((tok, i) => tokenHtml(tok) + (i < toks.length - 1 ? "," : ""))
            .join(" ");
    return html;
}

// ─── C syntax highlighter ─────────────────────────────────────────────────
function highlightC(code: string): string {
    const esc = (s: string): string =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const C_KEYWORDS = new Set([
        "int",
        "char",
        "float",
        "double",
        "long",
        "short",
        "unsigned",
        "signed",
        "void",
        "return",
        "if",
        "else",
        "while",
        "for",
        "do",
        "break",
        "continue",
        "switch",
        "case",
        "default",
        "struct",
        "union",
        "typedef",
        "static",
        "const",
        "extern",
        "sizeof",
        "enum",
    ]);
    const tokens: Token[] = [];
    let i = 0;
    while (i < code.length) {
        // Block comment
        if (code[i] === "/" && code[i + 1] === "*") {
            const end = code.indexOf("*/", i + 2);
            const val = end === -1 ? code.slice(i) : code.slice(i, end + 2);
            tokens.push(["comment", val]);
            i += val.length;
            continue;
        }
        // Line comment
        if (code[i] === "/" && code[i + 1] === "/") {
            const end = code.indexOf("\n", i);
            const val = end === -1 ? code.slice(i) : code.slice(i, end);
            tokens.push(["comment", val]);
            i += val.length;
            continue;
        }
        // String literal
        if (code[i] === '"') {
            let j = i + 1;
            while (j < code.length && code[j] !== '"') {
                if (code[j] === "\\") j++;
                j++;
            }
            tokens.push(["string", code.slice(i, j + 1)]);
            i = j + 1;
            continue;
        }
        // Char literal
        if (code[i] === "'") {
            let j = i + 1;
            while (j < code.length && code[j] !== "'") {
                if (code[j] === "\\") j++;
                j++;
            }
            tokens.push(["string", code.slice(i, j + 1)]);
            i = j + 1;
            continue;
        }
        // Identifier / keyword / function call
        if (/[a-zA-Z_]/.test(code[i])) {
            let j = i;
            while (j < code.length && /\w/.test(code[j])) j++;
            const word = code.slice(i, j);
            let k = j;
            while (k < code.length && code[k] === " ") k++;
            if (code[k] === "(") tokens.push(["fn" as TokenKind, word]);
            else if (C_KEYWORDS.has(word))
                tokens.push(["kw" as TokenKind, word]);
            else tokens.push(["text" as TokenKind, word]);
            i = j;
            continue;
        }
        // Number
        if (/[0-9]/.test(code[i])) {
            let j = i;
            while (j < code.length && /[0-9a-fA-FxX.]/.test(code[j])) j++;
            tokens.push(["num", code.slice(i, j)]);
            i = j;
            continue;
        }
        // Everything else
        tokens.push(["text", code[i]]);
        i++;
    }
    return tokens
        .map(([type, val]: Token) => {
            const e = esc(val);
            switch (type) {
                case "comment":
                    return `<span class="cmt">${e}</span>`;
                case "string":
                    return `<span class="reg">${e}</span>`;
                case "kw":
                    return `<span class="kw">${e}</span>`;
                case "fn":
                    return `<span class="fn">${e}</span>`;
                case "num":
                    return `<span class="imm">${e}</span>`;
                default:
                    return e;
            }
        })
        .join("");
}

// ─── Simulator ────────────────────────────────────────────────────────────
function simulate(prog: Program, assembled: AssemblyResult): Step[] {
    const { sourceInstrs, addrToSourceIdx, labels } = assembled;

    // Initialize registers (all zero, then apply initialRegs)
    const regs: Record<string, number> = {};
    for (const r of ALL_REGS) regs[r] = 0;
    regs.zero = 0;
    for (const [k, v] of Object.entries(prog.initialRegs)) regs[k] = v;
    // s0 and fp are the same hardware register (x8)
    regs.fp = regs.s0;

    const mem = new Map(); // addr (number) → value (number)
    const slotLabels = new Map(); // addr (number) → saved register name string

    let pc = labels[prog.entryPoint];

    // callStack: [{fn, entrySpBefore, allocatedSize}]
    // entrySpBefore: sp at the moment this function was entered
    // allocatedSize: bytes allocated by prologue (entrySpBefore - currentSp when inside frame)
    const callStack = [
        {
            fn: prog.entryPoint,
            entrySpBefore: regs.sp,
            allocatedSize: 0,
        },
    ];

    const steps: Step[] = [];

    function snap() {
        return {
            regs: { ...regs },
            mem: new Map(mem),
            slotLabels: new Map(slotLabels),
            callStack: callStack.map((f) => ({ ...f })),
            pc,
        };
    }

    function makeStep(
        s: ReturnType<typeof snap>,
        hiReg: string[],
        hiSlots: number[],
        instrAddr: number | null,
        nextAddr: number | null,
    ): Step {
        return {
            aHl: instrAddr != null ? [instrAddr] : [],
            nextAddr: nextAddr ?? null,
            regs: s.regs,
            hiReg: hiReg || [],
            mem: s.mem,
            hiSlots: hiSlots || [],
            slotLabels: s.slotLabels,
            callStack: s.callStack,
        };
    }

    function syncFpS0(rd: string): void {
        if (rd === "s0") regs.fp = regs.s0;
        if (rd === "fp") regs.s0 = regs.fp;
    }

    // Emit initial step (state before first instruction)
    steps.push(makeStep(snap(), [], [], null, pc));

    const MAX_STEPS = 500;

    while (steps.length < MAX_STEPS) {
        const siIdx = addrToSourceIdx.get(pc);
        if (siIdx == null) break;
        const si = sourceInstrs[siIdx];

        const instrAddr = si.firstAddr;
        let hiReg: string[] = [],
            hiSlots: number[] = [];

        const immOps: Record<string, (a: number, b: number) => number> = {
            addi: (a, b) => a + b,
            andi: (a, b) => a & b,
            ori: (a, b) => a | b,
            xori: (a, b) => a ^ b,
            slli: (a, b) => a << b,
            srli: (a, b) => a >>> b,
            srai: (a, b) => a >> b,
        };
        const regOps: Record<string, (a: number, b: number) => number> = {
            add: (a, b) => a + b,
            sub: (a, b) => a - b,
            mul: (a, b) => a * b,
            div: (a, b) => (b === 0 ? 0 : Math.trunc(a / b)),
            rem: (a, b) => (b === 0 ? a : a % b),
            and: (a, b) => a & b,
            or: (a, b) => a | b,
            xor: (a, b) => a ^ b,
            sll: (a, b) => a << b,
            srl: (a, b) => a >>> b,
            sra: (a, b) => a >> b,
        };
        const branchConds: Record<string, (a: number, b: number) => boolean> = {
            beq: (a, b) => a === b,
            bne: (a, b) => a !== b,
            blt: (a, b) => a < b,
            bge: (a, b) => a >= b,
            bltu: (a, b) => a >>> 0 < b >>> 0,
            bgeu: (a, b) => a >>> 0 >= b >>> 0,
        };

        for (let ciIdx = 0; ciIdx < si.concretes.length; ciIdx++) {
            const ci = si.concretes[ciIdx]!;
            const ciAddr = si.firstAddr + ciIdx * 4;
            switch (ci.op) {
                case "addi":
                case "andi":
                case "ori":
                case "xori":
                case "slli":
                case "srli":
                case "srai": {
                    const val = immOps[ci.op](regs[ci.rs1], ci.imm);
                    regs[ci.rd] = val;
                    syncFpS0(ci.rd);
                    pc += 4;
                    hiReg.push(ci.rd);
                    if (ci.rd === "sp") {
                        let top = null;
                        for (let i = callStack.length - 1; i >= 0; i--) {
                            if (callStack[i].fn === si.fn) {
                                top = callStack[i];
                                break;
                            }
                        }
                        if (!top) top = callStack[callStack.length - 1];
                        top.allocatedSize = top.entrySpBefore - val;
                    }
                    break;
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
                case "sra": {
                    const val = regOps[ci.op](regs[ci.rs1], regs[ci.rs2]);
                    regs[ci.rd] = val;
                    syncFpS0(ci.rd);
                    pc += 4;
                    hiReg.push(ci.rd);
                    break;
                }

                case "lui": {
                    const val = ci.imm << 12;
                    regs[ci.rd] = val;
                    syncFpS0(ci.rd);
                    pc += 4;
                    hiReg.push(ci.rd);
                    break;
                }

                case "auipc": {
                    regs[ci.rd] = ciAddr + (ci.imm << 12);
                    syncFpS0(ci.rd);
                    pc += 4;
                    hiReg.push(ci.rd);
                    break;
                }

                case "jal": {
                    if (ci.rd !== "zero") {
                        regs[ci.rd] = ciAddr + 4;
                        syncFpS0(ci.rd);
                        hiReg.push(ci.rd);
                    }
                    pc = ciAddr + ci.target;
                    break;
                }

                case "jalr": {
                    const jumpTarget = (regs[ci.rs1] + ci.imm) & ~1;
                    if (si.parsed.op === "call") {
                        callStack.push({
                            fn: (si.parsed as any).target,
                            entrySpBefore: regs.sp,
                            allocatedSize: 0,
                        });
                    }
                    if (ci.rd !== "zero") {
                        regs[ci.rd] = ciAddr + 4;
                        syncFpS0(ci.rd);
                        hiReg.push(ci.rd);
                    }
                    pc = jumpTarget;
                    break;
                }

                case "sw":
                case "sh":
                case "sb": {
                    const addr = regs[ci.rs1] + ci.offset;
                    mem.set(addr, regs[ci.rs2]);
                    slotLabels.set(addr, ci.rs2);
                    pc += 4;
                    hiSlots.push(addr);
                    break;
                }

                case "lw":
                case "lh":
                case "lb":
                case "lhu":
                case "lbu": {
                    const addr = regs[ci.rs1] + ci.offset;
                    regs[ci.rd] = mem.get(addr) ?? 0;
                    syncFpS0(ci.rd);
                    pc += 4;
                    hiReg.push(ci.rd);
                    hiSlots.push(addr);
                    break;
                }

                case "beq":
                case "bne":
                case "blt":
                case "bge":
                case "bltu":
                case "bgeu": {
                    const taken = branchConds[ci.op](
                        regs[ci.rs1],
                        regs[ci.rs2],
                    );
                    pc = taken ? ciAddr + ci.target : pc + 4;
                    break;
                }

                default: {
                    pc += 4;
                    break;
                }
            }
        }

        steps.push(makeStep(snap(), hiReg, hiSlots, instrAddr, pc));
    }

    return steps;
}

// ─── Concrete instruction serializer ──────────────────────────────────────
function fmtConcrete(c: ConcreteSpec, addr: number): string {
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

// ─── Build assembly view ───────────────────────────────────────────────────
function buildAsmView(assembled: AssemblyResult): void {
    const { sourceInstrs } = assembled;
    const el = document.getElementById("view-asm")!;
    let html = "";
    let lastFn = null;

    for (const si of sourceInstrs) {
        if (si.fn !== lastFn) {
            if (lastFn !== null) {
                html += `<div class="line"><span class="asm-addr"></span><span> </span></div>`;
            }
            html += `<div class="line"><span class="asm-addr"></span><span class="lbl">${si.fn}:</span></div>`;
            lastFn = si.fn;
        }
        const tip = ` data-tooltip="${si.concretes.map((c, i) => fmtConcrete(c, si.firstAddr + i * 4)).join("&#10;")}"`;
        html += `<div class="line" id="al-${si.firstAddr.toString(16)}"${tip}><span class="pc-arrow">▶</span><span class="asm-addr">${hx(si.firstAddr)}</span><span>  ${highlightInstr(si.raw)}</span></div>`;
    }

    el.innerHTML = html;
}

// ─── Render ───────────────────────────────────────────────────────────────
let DISPLAY_REGS: DisplayReg[] = [];

function computeDisplayRegs(
    prog: Program,
    assembled: AssemblyResult,
): DisplayReg[] {
    const { sourceInstrs } = assembled;
    const used = new Set(["sp", "ra"]);
    for (const r of Object.keys(prog.initialRegs)) used.add(r);
    for (const si of sourceInstrs) {
        for (const c of si.concretes) {
            for (const field of ["rd", "rs1", "rs2"] as const) {
                const val = (c as Record<string, unknown>)[field];
                if (
                    typeof val === "string" &&
                    REG_META[val as keyof typeof REG_META]
                )
                    used.add(val);
            }
        }
    }
    return ALL_REGS.filter((r) => used.has(r)).map((r) => ({
        name: r,
        desc: REG_META[r as keyof typeof REG_META]?.desc ?? "",
        key: r,
    }));
}

function fmtRegVal(key: string, val: number | null): string {
    if (val == null) return RAND_REGS[key] ?? "?";
    return hx(val);
}

function render(s: Step): void {
    // Assembly highlight — keyed by instruction address
    document
        .querySelectorAll("#view-asm .line.hl")
        .forEach((el) => el.classList.remove("hl"));
    clearTimeout(_hlTimeout ?? undefined);
    for (const addr of s.aHl || []) {
        const el = document.getElementById("al-" + addr.toString(16));
        if (el) {
            el.classList.add("hl");
            el.scrollIntoView({
                block: "nearest",
                behavior: "smooth",
            });
        }
    }
    if ((s.aHl || []).length > 0) {
        _hlTimeout = setTimeout(() => {
            document
                .querySelectorAll("#view-asm .line.hl")
                .forEach((el) => el.classList.remove("hl"));
        }, 400);
    }

    // Next-instruction arrow — clear immediately, re-add after highlight finishes
    clearTimeout(_nextInstrTimeout ?? undefined);
    document
        .querySelectorAll("#view-asm .line.next-instr")
        .forEach((el) => el.classList.remove("next-instr"));
    const applyNextInstr = (): void => {
        if (s.nextAddr != null) {
            const el = document.getElementById("al-" + s.nextAddr.toString(16));
            if (el) {
                el.classList.add("next-instr");
                if ((s.aHl || []).length === 0)
                    el.scrollIntoView({
                        block: "nearest",
                        behavior: "smooth",
                    });
            }
        }
    };
    if ((s.aHl || []).length > 0) {
        _nextInstrTimeout = setTimeout(applyNextInstr, 400);
    } else {
        applyNextInstr();
    }

    // Registers
    const hiR = new Set(s.hiReg || []);
    const pcRow = `<div class="reg-row pc-row">
  <span class="reg-name">pc</span>
  <span class="reg-val">${s.nextAddr != null ? hx(s.nextAddr) : "?"}</span>
  <span class="reg-desc">program counter</span>
</div>`;
    document.getElementById("reg-list")!.innerHTML = pcRow + DISPLAY_REGS.map((r) => {
        const val = s.regs ? s.regs[r.key] : null;
        const tip =
            val != null
                ? `data-tooltip="sin signo: ${val >>> 0}&#10;con signo: ${val | 0}"`
                : "";
        return `<div class="reg-row${hiR.has(r.name) ? " hi" : ""}">
  <span class="reg-name">${r.name}</span>
  <span class="reg-val" ${tip}>${fmtRegVal(r.key, val)}</span>
  <span class="reg-desc">${r.desc}</span>
</div>`;
    }).join("");

    // Stack
    buildStack(s);
    requestAnimationFrame(() => {
        positionSpArrow(s);
        positionLabels(s);
        positionOffsets(s);
    });

    // Controls
    document.getElementById("step-counter")!.textContent =
        `${cur + 1} / ${STEPS.length}`;
    const n = STEPS.length;
    const pct = n <= 1 ? 100 : (cur / (n - 1)) * 100;
    (document.getElementById("progress-fill") as HTMLElement).style.width =
        pct + "%";
    (document.getElementById("progress-thumb") as HTMLElement).style.left =
        `clamp(7px, ${pct}%, calc(100% - 7px))`;
    (document.getElementById("btn-prev") as HTMLButtonElement).disabled =
        cur === 0;
    (document.getElementById("btn-next") as HTMLButtonElement).disabled =
        cur === STEPS.length - 1;
}

// ─── Stack builder ────────────────────────────────────────────────────────
// Slot IDs use lowercase hex address: "slot-ff0", "slot-1000", etc.
function buildStack(s: Step): void {
    const hiS = new Set(s.hiSlots || []);
    const col = document.getElementById("stack-column")!;
    const currentSp = s.regs ? s.regs.sp : 0;
    const callerBase =
        s.callStack && s.callStack.length > 0
            ? s.callStack[0].entrySpBefore
            : currentSp + 16;

    let html = "";

    // ── Top ghost: caller frame ──
    let callerSlots = "";
    for (let i = 0; i < GHOST_ROWS; i++) {
        const addr = callerBase + (GHOST_ROWS - i) * 4;
        const opacity = ((i + 1) / (GHOST_ROWS + 1)).toFixed(2);
        callerSlots +=
            `<div class="frame-slot" id="slot-${addr.toString(16)}" style="opacity:${opacity}">` +
            `<span class="slot-name">${hx(addr)}</span><span class="slot-val">—</span></div>`;
    }
    // The slot at callerBase itself (boundary)
    callerSlots +=
        `<div class="frame-slot" id="slot-${callerBase.toString(16)}">` +
        `<span class="slot-name">${hx(callerBase)}</span>` +
        `<span class="slot-val" style="color:var(--text-faint)">—</span></div>`;

    html += `<div class="frame caller" id="fr-caller">
  <div class="frame-ellipsis"><div>dirección alta</div><div>↑</div></div>
  ${callerSlots}
</div>`;

    // ── Active frames: oldest (index 0) to newest ──
    const activeFrames = (s.callStack || []).filter(
        (f) => currentSp < f.entrySpBefore,
    );
    for (let fi = 0; fi < activeFrames.length; fi++) {
        const frame = activeFrames[fi];
        const color = FRAME_COLORS[fi % FRAME_COLORS.length];
        const frameTop = frame.entrySpBefore;
        const frameBot = frame.entrySpBefore - frame.allocatedSize;

        let frameSlots = "";
        for (let addr = frameTop - 4; addr >= frameBot; addr -= 4) {
            const label = s.slotLabels && s.slotLabels.get(addr);
            const val = s.mem && s.mem.get(addr);
            const slotName = label
                ? `${hx(addr)}&nbsp;&nbsp;${label}`
                : hx(addr);
            const slotVal = val !== undefined ? hx(val) : "—";
            const slotTip =
                val !== undefined
                    ? `data-tooltip="sin signo: ${val >>> 0}&#10;con signo: ${val | 0}"`
                    : "";
            const isHi = hiS.has(addr);
            const nameColor = label ? "var(--blue)" : "";
            frameSlots +=
                `<div class="frame-slot${isHi ? ' hi' : ''}" id="slot-${addr.toString(16)}" style="background:${color}">` +
                `<span class="slot-name"${nameColor ? ` style="color:${nameColor}"` : ""}>${slotName}</span>` +
                `<span class="slot-val" ${slotTip}>${slotVal}</span></div>`;
        }

        html += `<div class="frame" id="fr-active-${fi}" data-fn="${frame.fn}">${frameSlots}</div>`;
    }

    // ── Bottom ghost: free zone below sp ──
    let freeSlots = "";
    for (let i = 0; i < GHOST_ROWS; i++) {
        const addr = currentSp - (i + 1) * 4;
        const opacity = ((GHOST_ROWS - i) / (GHOST_ROWS + 1)).toFixed(2);
        freeSlots +=
            `<div class="frame-slot" style="opacity:${opacity};background:var(--bg);border-top-style:dashed">` +
            `<span class="slot-name" style="color:var(--text-faint)">${hx(addr)}</span>` +
            `<span class="slot-val" style="color:var(--text-faint)">—</span></div>`;
    }
    html += `<div class="frame free" id="fr-free">
  ${freeSlots}
  <div class="frame-ellipsis"><div>↓</div><div>dirección baja</div></div>
</div>`;

    col.innerHTML = html;
}

// ─── SP arrow ─────────────────────────────────────────────────────────────
let _firstArrowRender = true;

function positionSpArrow(s: Step): void {
    const arrow = document.getElementById("sp-arrow");
    const wrapper = document.getElementById("stack-wrapper");
    if (!arrow || !wrapper) return;

    const spAddr = s.regs ? s.regs.sp : 0;

    // Find the slot element at the current sp address
    let target = document.getElementById("slot-" + spAddr.toString(16));

    // Fallback: the boundary slot at callerBase
    if (!target) {
        const callerBase =
            s.callStack && s.callStack.length > 0
                ? s.callStack[0].entrySpBefore
                : spAddr;
        target = document.getElementById("slot-" + callerBase.toString(16));
    }
    if (!target) return;

    const wRect = wrapper.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const top = tRect.top - wRect.top + tRect.height / 2;

    if (_firstArrowRender) {
        arrow.style.transition = "none";
        arrow.style.top = top + "px";
        arrow.getBoundingClientRect(); // force reflow before re-enabling transition
        arrow.style.transition = "";
        _firstArrowRender = false;
    } else {
        arrow.style.top = top + "px";
    }
}

// ─── Frame labels ─────────────────────────────────────────────────────────
function positionLabels(s: Step): void {
    const col = document.getElementById("stack-column");
    const labelsEl = document.getElementById("frame-labels");
    if (!col || !labelsEl) return;

    const colTop = col.getBoundingClientRect().top;
    let html = "";

    const currentSp = s.regs ? s.regs.sp : 0;
    const activeFrames = (s.callStack || []).filter(
        (f) => currentSp < f.entrySpBefore,
    );
    for (let fi = 0; fi < activeFrames.length; fi++) {
        const frame = activeFrames[fi];
        const frEl = document.getElementById("fr-active-" + fi);
        if (!frEl) continue;
        const firstSlot = frEl.querySelector(".frame-slot");
        if (!firstSlot) continue;
        const rect = firstSlot.getBoundingClientRect();
        const top = rect.top - colTop + rect.height / 2;
        html += `<span class="flabel" style="top:${top}px">${frame.fn}</span>`;
    }

    labelsEl.innerHTML = html;
}

// ─── Offset arrows ────────────────────────────────────────────────────────
function positionOffsets(s: Step): void {
    const container = document.getElementById("offset-arrows");
    const wrapper = document.getElementById("stack-wrapper");
    if (!container || !wrapper) return;

    const wTop = wrapper.getBoundingClientRect().top;
    const spVal = s.regs ? s.regs.sp : 0;
    let html = "";

    // Iterate all named slot elements and label those within ±OFFSET_MAX of sp
    const slots = document.querySelectorAll(".frame-slot[id^='slot-']");
    for (const slot of slots as NodeListOf<HTMLElement>) {
        const addrHex = slot.id.slice(5); // "slot-ff0" → "ff0"
        const addr = parseInt(addrHex, 16);
        const offset = addr - spVal;
        if (offset === 0) continue; // sp+0 is shown by the sp arrow itself
        if (Math.abs(offset) > OFFSET_MAX) continue;
        const sign = offset > 0 ? "+" : "";
        const opacity = parseFloat(slot.style.opacity || "1");
        const rect = slot.getBoundingClientRect();
        const top = rect.top - wTop + rect.height / 2;
        html += `<div class="offset-arrow" style="top:${top}px;opacity:${opacity}">sp${sign}${offset}</div>`;
    }

    container.innerHTML = html;
}

// ─── Tab switcher ─────────────────────────────────────────────────────────
let _activeTab: "asm" | "c" = "asm";

function switchTab(tab: "asm" | "c"): void {
    _activeTab = tab;
    (document.getElementById("pane-asm") as HTMLElement).style.display =
        tab === "asm" ? "" : "none";
    (document.getElementById("pane-c") as HTMLElement).style.display =
        tab === "c" ? "" : "none";
    document
        .getElementById("tab-asm")!
        .classList.toggle("active", tab === "asm");
    document.getElementById("tab-c")!.classList.toggle("active", tab === "c");
}

// ─── Navigation ───────────────────────────────────────────────────────────
let _hlTimeout: ReturnType<typeof setTimeout> | null = null;
let _nextInstrTimeout: ReturnType<typeof setTimeout> | null = null;
let cur = 0;
let STEPS: Step[] = [];

function goTo(idx: number): void {
    cur = Math.max(0, Math.min(STEPS.length - 1, idx));
    render(STEPS[cur]!);
}

function go(dir: number): void {
    goTo(cur + dir);
}

// ─── Program loader ───────────────────────────────────────────────────────
function buildTicks(): void {
    bar.querySelectorAll(".step-tick").forEach((el) => el.remove());
    const n = STEPS.length;
    for (let i = 1; i < n - 1; i++) {
        const tick = document.createElement("div");
        tick.className = "step-tick";
        tick.style.left = (i / (n - 1)) * 100 + "%";
        bar.appendChild(tick);
    }
}

function showConfigError(body: string): void {
    document.getElementById("stack-area")!.innerHTML =
        `<div style="padding:32px 24px;color:var(--red);font-family:var(--mono);font-size:15px;line-height:1.8;max-width:420px">` +
        `<div style="font-weight:600;font-size:17px;margin-bottom:12px">Error de configuración</div>` +
        body +
        `</div>`;
    document.getElementById("step-counter")!.textContent = "— / —";
    (document.getElementById("btn-prev") as HTMLButtonElement).disabled = true;
    (document.getElementById("btn-next") as HTMLButtonElement).disabled = true;
}

function loadProgram(prog: Program): void {
    switchTab("asm");
    const cTab = document.getElementById("tab-c") as HTMLButtonElement;
    if (prog.cCode) {
        document.getElementById("view-c")!.innerHTML = highlightC(prog.cCode);
        cTab.disabled = false;
    } else {
        document.getElementById("view-c")!.textContent = "";
        cTab.disabled = true;
    }

    // Assemble first — catches unknown instructions before any other check
    const assembled = assembleProgram(prog);
    if (assembled instanceof ParseError) {
        showConfigError(
            `Instrucción desconocida: <code>${assembled.raw}</code> en función <code>${assembled.fn}</code>.`,
        );
        return;
    }
    if (assembled instanceof RangeError) {
        showConfigError(
            `Salto fuera de rango: <code>${assembled.raw}</code> en función <code>${assembled.fn}</code>.`,
        );
        return;
    }

    // Validate that entryPoint names a defined function
    if (!(prog.entryPoint in prog.functions)) {
        buildAsmView(assembled);
        showConfigError(
            `Punto de entrada <code>${prog.entryPoint}</code> no existe en las funciones definidas.<br><br>` +
                `<span style="color:var(--text-dim)">Funciones disponibles: ${Object.keys(
                    prog.functions,
                )
                    .map((f) => `<code>${f}</code>`)
                    .join(", ")}. ` +
                `Ajusta <code>entryPoint</code>.</span>`,
        );
        return;
    }

    // Validate that initial ra points outside the program's address range
    const { sourceInstrs } = assembled;
    const progStart = prog.baseAddress;
    const lastSi = sourceInstrs[sourceInstrs.length - 1]!;
    const progEnd = lastSi.firstAddr + lastSi.concretes.length * 4;
    const initRa = prog.initialRegs.ra ?? 0;
    if (initRa >= progStart && initRa < progEnd) {
        buildAsmView(assembled);
        showConfigError(
            `<code>ra</code> inicial (<code>${hx(initRa)}</code>) apunta dentro del rango del programa` +
                ` [<code>${hx(progStart)}</code>–<code>${hx(progEnd - 4)}</code>].<br><br>` +
                `<span style="color:var(--text-dim)">El simulador no puede determinar cuándo termina la ejecución. ` +
                `Ajusta <code>initialRegs.ra</code> a una dirección fuera del programa.</span>`,
        );
        return;
    }

    _firstArrowRender = true;
    DISPLAY_REGS = computeDisplayRegs(prog, assembled);
    STEPS = simulate(prog, assembled);
    cur = 0;
    buildAsmView(assembled);
    render(STEPS[0]!);
    buildTicks();
}

// ─── Init ─────────────────────────────────────────────────────────────────
const rh = (): string =>
    "0x" +
    Math.floor(Math.random() * 0xffffffff)
        .toString(16)
        .toUpperCase()
        .padStart(8, "0");
const RAND_REGS: Record<string, string> = {};
for (const r of ALL_REGS) RAND_REGS[r] = rh();

// Progress bar scrubber
const bar = document.querySelector(".progress-bar") as HTMLElement;
const fill = document.getElementById("progress-fill") as HTMLElement;
const thumb = document.getElementById("progress-thumb") as HTMLElement;
function scrubTo(e: PointerEvent): void {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(
        1,
        Math.max(0, (e.clientX - rect.left) / rect.width),
    );
    goTo(Math.round(ratio * (STEPS.length - 1)));
}
bar.addEventListener("pointerdown", (e) => {
    fill.classList.add("scrubbing");
    thumb.classList.add("scrubbing");
    bar.setPointerCapture(e.pointerId);
    scrubTo(e);
});
bar.addEventListener("pointermove", (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    scrubTo(e);
});
bar.addEventListener("pointerup", (e) => {
    bar.releasePointerCapture(e.pointerId);
    fill.classList.remove("scrubbing");
    thumb.classList.remove("scrubbing");
});

// Populate program selector
const sel = document.getElementById("prog-select") as HTMLSelectElement;
PROGRAMS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.name;
    sel.appendChild(opt);
});
sel.addEventListener("change", () =>
    loadProgram(PROGRAMS[parseInt(sel.value)]!),
);

// Build persistent stack skeleton (arrow + column + labels)
document.getElementById("stack-area")!.innerHTML = `
  <div class="stack-wrapper" id="stack-wrapper">
    <div class="offset-arrows" id="offset-arrows"></div>
    <div class="sp-arrow" id="sp-arrow"><span class="sp-label">sp</span><span class="sp-arrow-shaft"></span><span class="sp-arrow-head"></span></div>
    <div class="stack-column" id="stack-column"></div>
    <div class="frame-labels" id="frame-labels"></div>
  </div>
`;

loadProgram(PROGRAMS[0]);

// ─── Tooltip ──────────────────────────────────────────────────────────────
const tt = document.createElement("div");
tt.id = "tooltip";
document.body.appendChild(tt);

document.addEventListener("mouseover", (e) => {
    const el = (e.target as Element | null)?.closest(
        "[data-tooltip]",
    ) as HTMLElement | null;
    if (!el) {
        tt.style.display = "none";
        return;
    }
    tt.textContent = el.dataset["tooltip"] ?? null;
    tt.style.display = "block";
});
document.addEventListener("mouseout", (e) => {
    if (!(e.target as Element | null)?.closest("[data-tooltip]")) return;
    tt.style.display = "none";
});
document.addEventListener("mousemove", (e) => {
    if (tt.style.display === "none") return;
    const gap = 12;
    let x = e.clientX + gap;
    let y = e.clientY + gap;
    if (x + tt.offsetWidth > window.innerWidth)
        x = e.clientX - tt.offsetWidth - gap;
    if (y + tt.offsetHeight > window.innerHeight)
        y = e.clientY - tt.offsetHeight - gap;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
});

// ─── Button event listeners (replaces inline onclick attributes) ───────────
document.getElementById("btn-prev")!.addEventListener("click", () => go(-1));
document.getElementById("btn-next")!.addEventListener("click", () => go(1));
document
    .getElementById("tab-asm")!
    .addEventListener("click", () => switchTab("asm"));
document
    .getElementById("tab-c")!
    .addEventListener("click", () => switchTab("c"));
