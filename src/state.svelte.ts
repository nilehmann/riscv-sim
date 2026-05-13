import type { AssemblyResult, DisplayReg, Program, Step } from "./types";
import { ConfigError, OverlapError, ParseError, RangeError } from "./types";
import { assembleProgram, hx } from "./assembler";
import { ALL_REGS, REG_META, simulate } from "./simulator";
import { PROGRAMS } from "./programs";

// ─── Helpers ──────────────────────────────────────────────────────────────

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
        if (typeof val === "string" && REG_META[val as keyof typeof REG_META])
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

// ─── UIState ─────────────────────────────────────────────────────────────
// Visual toggles and transient UI state that is independent of the simulation.

export class UIState {
  activeTab = $state<"asm" | "c">("asm");
  showFp = $state(false);
  /** Suppresses the CSS transition on the first sp-arrow render. Reset on program load. */
  firstArrowRender = $state(true);
  /** Suppresses the CSS transition on the first fp-arrow render. Reset when fp is toggled on. */
  firstFpArrowRender = $state(true);
  selectorOpen = $state(false);
}

export const ui = new UIState();

// ─── SimulationState ──────────────────────────────────────────────────────
// Owns the loaded program, assembled code, simulation steps, and navigation.

export type LoadError =
  | { kind: "ParseError"; raw: string; label: string; message?: string }
  | { kind: "RangeError"; raw: string; label: string }
  | { kind: "OverlapError"; codeEnd: number; stackBase: number }
  | { kind: "ConfigError"; message: string }
  | { kind: "BadEntryPoint"; entryPoint: string; available: string[] }
  | { kind: "BadInitRa"; ra: number; progStart: number; progEnd: number };

export class SimulationState {
  // ── Core state ──
  program = $state<Program | null>(null);
  assembled = $state<AssemblyResult | null>(null);
  steps = $state<Step[]>([]);
  /** Concrete step index of the last concrete instr for source[i]. sourcePositions[0]=0, then sourceToConcrete values. */
  sourcePositions = $state<number[]>([]);
  displayRegs = $state<DisplayReg[]>([]);
  cur = $state(0);
  asmMode = $state<"source" | "assembled">("source");
  loadError = $state<LoadError | null>(null);

  // ── Derived navigation ──
  currentSourcePosIdx = $derived.by(() => {
    let p = 0;
    for (let i = this.sourcePositions.length - 1; i >= 0; i--) {
      if (this.sourcePositions[i]! <= this.cur) {
        p = i;
        break;
      }
    }
    return p;
  });

  posIdx = $derived(
    this.asmMode === "source" ? this.currentSourcePosIdx : this.cur,
  );

  total = $derived(
    this.asmMode === "source" ? this.sourcePositions.length : this.steps.length,
  );

  progress = $derived(
    this.total <= 1 ? 100 : (this.posIdx / (this.total - 1)) * 100,
  );

  currentStep = $derived(this.steps[this.cur] ?? null);

  // ── Actions ──

  goTo(idx: number): void {
    this.cur = Math.max(0, Math.min(this.steps.length - 1, idx));
  }

  go(dir: number): void {
    if (this.asmMode === "assembled") {
      this.goTo(this.cur + dir);
      return;
    }
    const p = this.currentSourcePosIdx;
    const newP = Math.max(
      0,
      Math.min(this.sourcePositions.length - 1, p + dir),
    );
    this.goTo(this.sourcePositions[newP]!);
  }

  scrubTo(ratio: number): void {
    if (this.asmMode === "source") {
      const posIdx = Math.round(ratio * (this.sourcePositions.length - 1));
      this.goTo(this.sourcePositions[posIdx]!);
    } else {
      this.goTo(Math.round(ratio * (this.steps.length - 1)));
    }
  }

  switchAsmMode(mode: "source" | "assembled"): void {
    this.asmMode = mode;
    if (mode === "source") {
      // Snap cur down to the nearest source boundary
      this.cur = this.sourcePositions[this.currentSourcePosIdx]!;
    }
  }

  loadProgram(prog: Program): void {
    this.loadError = null;

    const assembled = assembleProgram(prog);

    if (assembled instanceof ParseError) {
      this.loadError = {
        kind: "ParseError",
        raw: assembled.raw,
        label: assembled.label,
        message: assembled.message,
      };
      return;
    }
    if (assembled instanceof RangeError) {
      this.loadError = {
        kind: "RangeError",
        raw: assembled.raw,
        label: assembled.label,
      };
      return;
    }
    if (assembled instanceof ConfigError) {
      this.loadError = { kind: "ConfigError", message: assembled.message };
      return;
    }
    if (assembled instanceof OverlapError) {
      this.loadError = {
        kind: "OverlapError",
        codeEnd: assembled.codeEnd,
        stackBase: assembled.stackBase,
      };
      return;
    }

    if (!(prog.entryPoint in assembled.labels)) {
      this.loadError = {
        kind: "BadEntryPoint",
        entryPoint: prog.entryPoint,
        available: Object.keys(assembled.labels),
      };
      return;
    }

    const { sourceInstrs } = assembled;
    const progStart = prog.baseAddress;
    const lastSi = sourceInstrs[sourceInstrs.length - 1]!;
    const progEnd = lastSi.firstAddr + lastSi.concretes.length * 4;
    const initRa = prog.initialRegs.ra ?? 0;
    if (initRa >= progStart && initRa < progEnd) {
      this.loadError = { kind: "BadInitRa", ra: initRa, progStart, progEnd };
      return;
    }

    const { steps, sourceToConcrete } = simulate(prog, assembled);

    this.program = prog;
    this.assembled = assembled;
    this.steps = steps;
    this.sourcePositions = [0, ...sourceToConcrete];
    this.displayRegs = computeDisplayRegs(prog, assembled);
    this.cur = 0;
    this.asmMode = "source";
    ui.activeTab = "asm";
    ui.firstArrowRender = true;
  }
}

export const sim = new SimulationState();

// ─── Random register values for uninitialized display ──────────────────────

function rh(): string {
  return (
    "0x" +
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .toUpperCase()
      .padStart(8, "0")
  );
}

export const RAND_REGS: Record<string, string> = Object.fromEntries(
  ALL_REGS.map((r) => [r, rh()]),
);

export function fmtRegVal(key: string, val: number | null | undefined): string {
  if (val == null) return RAND_REGS[key] ?? "?";
  return hx(val);
}

// ─── Load the first program immediately ───────────────────────────────────
sim.loadProgram(PROGRAMS[0]!);
