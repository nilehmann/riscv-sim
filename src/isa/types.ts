import type { AppError, Program } from "../types";
import type { Machine } from "../machine";

export type IsaId = "rv32" | "x86";

// ─── Display ──────────────────────────────────────────────────────────────

/** A syntax-highlighted piece of an instruction. Kinds match the CSS classes. */
export type Token =
  | { kind: "kw" | "reg" | "imm" | "punct"; text: string }
  | { kind: "label"; text: string; addr?: number };

// ─── Encoding ─────────────────────────────────────────────────────────────

export type FieldKind = "opcode" | "funct" | "reg" | "imm";

/** A bit range inside an encoding part. */
export interface BitField {
  /** e.g. "rd", "funct3", "imm[11:5]" */
  name: string;
  /** Bit range in the part's little-endian value (inclusive, hi >= lo). */
  hi: number;
  lo: number;
  /** Field value, already truncated to hi-lo+1 bits. */
  value: number;
  kind: FieldKind;
  /** Human meaning of the value, e.g. "STORE", "sw", "x2 (sp)". */
  note: string;
}

/** A named byte range of an instruction (opcode, ModRM, immediate, …). */
export interface EncodingPart {
  name: string;
  /** First byte of the part, relative to the instruction address. */
  offset: number;
  length: number;
  /** Color of a part that has no bit fields. */
  kind?: FieldKind;
  /** Human meaning of a part that has no bit fields. */
  note?: string;
  /** Bit-level breakdown, MSB first, covering every bit of the part. */
  fields?: BitField[];
}

export interface ImmPart {
  /** Field name this part comes from, or null for implicit zero bits. */
  field: string | null;
  bits: string;
}

export interface Encoding {
  /** Bytes in memory order. */
  bytes: number[];
  /** Instruction format, e.g. "S" for RISC-V S-type; null if not meaningful. */
  format: string | null;
  /** Parts in memory order, covering every byte. */
  parts: EncodingPart[];
  /** How a split immediate is reassembled from its fields, high to low. */
  imm: { parts: ImmPart[]; value: number } | null;
}

// ─── Execution ────────────────────────────────────────────────────────────

/** Control transfer performed by an instruction, used for frame tracking. */
export type ControlFlow =
  | { kind: "call"; returnAddr: number }
  | { kind: "jump" };

export interface ExecResult {
  /** Address of the next instruction. */
  next: number;
  hiReg?: string[];
  hiSlots?: number[];
  store?: StoreInfo;
  fault?: Fault;
  control?: ControlFlow;
}

/** A register (or other named value) written to memory, for slot labels. */
export interface StoreInfo {
  addr: number;
  reg: string;
  /** Bytes written. */
  size: number;
}

export type Fault = { type: "segfault"; addr: number } | { type: "divide" };

// ─── ISA ──────────────────────────────────────────────────────────────────

export interface ExpandCtx {
  /** Address the first concrete instruction is placed at. */
  addr: number;
  labels: Record<string, number>;
  raw: string;
  /** Labels on this line, for error messages. */
  lineLabels: string[];
}

/**
 * Everything the generic assembler, simulator and UI need to know about an
 * instruction set. P is the parsed source instruction, I the machine one.
 */
export interface Isa<P = any, I = any> {
  id: IsaId;
  name: string;
  /** Short name for titles and selectors, e.g. "RISC-V". */
  shortName: string;
  /** Register width in bytes. */
  wordBytes: 4 | 8;
  /** Stack slot size in bytes for the stack view. */
  slotBytes: 4 | 8;
  regs: {
    /** Canonical register names, in display order. */
    names: readonly string[];
    sp: string;
    fp: string;
    /** Name shown for the frame pointer arrow. */
    fpLabel: string;
    /** Register that always reads as zero, if any. */
    zero: string | null;
    /** Register that holds return addresses, if any. */
    returnAddr: string | null;
    /** Alternative names → canonical name. */
    aliases: Record<string, string>;
    /** Name of the program counter. */
    pc: string;
    /**
     * Width in bytes of registers that are a narrower view of a canonical
     * one (x86 eax → 4). Such names may appear in ExecResult.hiReg.
     */
    subRegBytes?: Record<string, number>;
  };
  /** Status flags kept in a pseudo-register, shown one by one. */
  flags?: { reg: string; bits: { name: string; bit: number }[] };
  /** Bytes below sp that may be accessed without moving sp. */
  redZone: number;
  /** Letter for each access size in bytes, e.g. { 4: "w", 2: "h", 1: "b" }. */
  sizeNames: Record<number, string>;
  /** Defaults for new programs. */
  defaults: { baseAddress: number; stackBase: number; sp: number };
  /** Starts a line comment. */
  lineComment: string;

  parseInstr(raw: string): P | AppError;
  /** Smallest possible encoded size in bytes, for the initial layout. */
  minSize(p: P): number;
  /** Machine instructions for p when placed at ctx.addr. */
  expand(p: P, ctx: ExpandCtx): I[] | AppError;
  size(i: I): number;
  encode(i: I): Encoding;
  /** Tokens for a machine instruction at addr. */
  tokens(i: I, addr: number): Token[];
  /** Tokens for a source line, preserving how operands were written. */
  sourceTokens(p: P, raw: string, labels: Record<string, number>): Token[];
  /** Whether p assembled to something other than itself. */
  isPseudo(p: P, concretes: I[]): boolean;
  execute(m: Machine, i: I, addr: number, size: number): ExecResult;
  /** Registers read or written by i. */
  regsUsed(i: I): string[];
  /** A deterministic filler instruction for garbage rows. */
  garbage(seed: number): I;
  /** Where the entry function returns to, given the initial machine state. */
  initialReturnAddr(m: Machine): number | null;
  /** Prepares the machine before the first instruction (optional). */
  setup?(m: Machine, prog: Program): void;
  /** Stack slots that have a known meaning before the program starts. */
  initialSlotLabels?(m: Machine): StoreInfo[];

  editor: { mnemonics: ReadonlySet<string> };
}
