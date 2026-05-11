import type {
    Program,
    AssemblyResult,
    Step,
    DisplayReg,
    Token,
    TokenKind,
} from "./types";
import { ParseError, RangeError, OverlapError, ConfigError } from "./types";
import { hx, assembleProgram, fmtConcreteRel } from "./assembler";
import { ALL_REGS, REG_META, REG_SET, simulate } from "./simulator";
import { PROGRAMS } from "./programs";
import { createIcons, Info } from "lucide";

const INSTR_INFO_ICON = `<i data-lucide="info"></i>`;

// Colors cycling per frame depth (index 0 = outermost active frame)
const FRAME_COLORS = [
    "var(--green-dim)",
    "var(--blue-dim)",
    "var(--orange-dim)",
    "var(--purple-dim)",
];
const GHOST_ROWS = 3;
const OFFSET_MAX = 64; // only show sp±N labels within this range


// ─── Syntax highlighter ───────────────────────────────────────────────────
const JUMP_OPS = new Set(["jal", "beq", "bne", "blt", "bge", "bltu", "bgeu"]);

interface HlCtx { labels: Record<string, number>; addr: number; }

function sp(cls: string, text: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
}

function highlightInstr(raw: string, ctx: HlCtx): HTMLElement {
    const s = raw.trim();
    const spIdx = s.indexOf(" ");
    const op = spIdx === -1 ? s : s.slice(0, spIdx);
    const rest = spIdx === -1 ? "" : s.slice(spIdx + 1);
    const isJump = JUMP_OPS.has(op);

    const wrapper = document.createElement("span");
    wrapper.append(sp("kw", op));
    if (!rest) return wrapper;

    const makeToken = (tok: string, isLast: boolean): (string | HTMLElement)[] => {
        const t = tok.trim();
        const memM = t.match(/^(-?\d+)\((\w+)\)$/);
        if (memM) return [sp("imm", memM[1]!), "(", sp("reg", memM[2]!), ")"];
        if (REG_SET.has(t)) return [sp("reg", t)];
        if (/^[+-]?\d+$/.test(t)) {
            if (isJump && isLast) {
                const targetAddr = ctx.addr + parseInt(t, 10);
                const el = sp("fn", t);
                el.dataset["targetAddr"] = String(targetAddr);
                el.dataset["tooltip"] = `addr: ${hx(targetAddr)}`;
                return [el];
            }
            return [sp("imm", t)];
        }
        // label name
        if (t in ctx.labels) {
            const el = sp("fn", t);
            el.dataset["targetAddr"] = String(ctx.labels[t]);
            el.dataset["tooltip"] = `addr: ${hx(ctx.labels[t]!)}`;
            return [el];
        }
        return [sp("fn", t)];
    };

    const toks = rest.split(",");
    wrapper.append(" ");
    toks.forEach((tok, i) => {
        wrapper.append(...makeToken(tok, i === toks.length - 1));
        if (i < toks.length - 1) wrapper.append(",");
        if (i < toks.length - 1) wrapper.append(" ");
    });
    return wrapper;
}

// ─── ASM view DOM helpers ─────────────────────────────────────────────────
function makeLine(addr: number | null): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "line";
    if (addr != null) el.id = `al-${addr.toString(16)}`;
    return el;
}

function pcArrowEl(): HTMLSpanElement {
    return sp("pc-arrow", "▶");
}

function addrSpan(addr: number): HTMLSpanElement {
    return sp("asm-addr", hx(addr));
}

function emptyAddrSpan(): HTMLSpanElement {
    return sp("asm-addr", "");
}

function makeInfoIcon(tooltip: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = "instr-info";
    s.dataset["tooltip"] = tooltip;
    s.innerHTML = INSTR_INFO_ICON;
    return s;
}

function makeInstrSpan(raw: string, ctx: HlCtx): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.append("  ", highlightInstr(raw, ctx));
    return wrapper;
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

// ─── Build assembled (concrete) view ──────────────────────────────────────
function buildAssembledView(assembled: AssemblyResult): void {
    const { sourceInstrs } = assembled;
    const el = document.getElementById("view-asm")!;
    el.textContent = "";
    let lastLabel = null;

    for (const si of sourceInstrs) {
        if (si.label !== lastLabel) {
            if (lastLabel !== null) {
                const sep = makeLine(null);
                sep.append(emptyAddrSpan(), document.createTextNode(" "));
                el.appendChild(sep);
            }
            const lblLine = makeLine(null);
            lblLine.append(emptyAddrSpan(), sp("lbl", `${si.label}:`));
            el.appendChild(lblLine);
            lastLabel = si.label;
        }
        if (si.concretes.length === 1) {
            const c = si.concretes[0]!;
            const ciAddr = si.firstAddr;
            const ctx: HlCtx = { labels: assembled.labels, addr: ciAddr };
            const line = makeLine(ciAddr);
            line.append(pcArrowEl(), addrSpan(ciAddr), makeInstrSpan(fmtConcreteRel(c, ciAddr), ctx), makeInfoIcon(si.raw));
            el.appendChild(line);
        } else {
            const group = document.createElement("div");
            group.className = "concrete-group";
            for (let i = 0; i < si.concretes.length; i++) {
                const c = si.concretes[i]!;
                const ciAddr = si.firstAddr + i * 4;
                const ctx: HlCtx = { labels: assembled.labels, addr: ciAddr };
                const line = makeLine(ciAddr);
                line.append(pcArrowEl(), addrSpan(ciAddr), makeInstrSpan(fmtConcreteRel(c, ciAddr), ctx));
                group.appendChild(line);
            }
            group.appendChild(makeInfoIcon(si.raw));
            el.appendChild(group);
        }
    }

    createIcons({ icons: { Info }, attrs: { width: "13", height: "13" } });
}

// ─── Build assembly view ───────────────────────────────────────────────────
function buildAsmView(assembled: AssemblyResult): void {
    const { sourceInstrs } = assembled;
    const el = document.getElementById("view-asm")!;
    el.textContent = "";
    let lastLabel = null;

    for (const si of sourceInstrs) {
        if (si.label !== lastLabel) {
            if (lastLabel !== null) {
                const sep = makeLine(null);
                sep.append(emptyAddrSpan(), document.createTextNode(" "));
                el.appendChild(sep);
            }
            const lblLine = makeLine(null);
            lblLine.append(emptyAddrSpan(), sp("lbl", `${si.label}:`));
            el.appendChild(lblLine);
            lastLabel = si.label;
        }
        const tipContent = si.concretes.map((c, i) => fmtConcreteRel(c, si.firstAddr + i * 4)).join("\n");
        const ctx: HlCtx = { labels: assembled.labels, addr: si.firstAddr };
        const line = makeLine(si.firstAddr);
        line.append(pcArrowEl(), addrSpan(si.firstAddr), makeInstrSpan(si.raw, ctx), makeInfoIcon(tipContent));
        el.appendChild(line);
    }

    createIcons({ icons: { Info }, attrs: { width: "13", height: "13" } });
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
    // Remap highlight addresses in source mode (concrete addr → source first addr)
    const aHl = (_asmMode === "source" && _assembled)
        ? (s.aHl || []).map((addr) => {
              const idx = _assembled!.addrToSourceIdx.get(addr);
              return idx != null ? _assembled!.sourceInstrs[idx]!.firstAddr : addr;
          })
        : (s.aHl || []);

    // Assembly highlight — keyed by instruction address
    document
        .querySelectorAll("#view-asm .line.hl")
        .forEach((el) => el.classList.remove("hl"));
    clearTimeout(_hlTimeout ?? undefined);
    for (const addr of aHl) {
        const el = document.getElementById("al-" + addr.toString(16));
        if (el) {
            el.classList.add("hl");
            el.scrollIntoView({
                block: "nearest",
                behavior: "smooth",
            });
        }
    }
    if (aHl.length > 0) {
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
                if (aHl.length === 0)
                    el.scrollIntoView({
                        block: "nearest",
                        behavior: "smooth",
                    });
            }
        }
    };
    if (aHl.length > 0) {
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

    // Controls — mode-aware position and total
    const posIdx = _asmMode === "source" ? currentSourcePosIdx() : cur;
    const total = _asmMode === "source" ? _sourcePositions.length : STEPS.length;
    document.getElementById("step-counter")!.textContent =
        `${posIdx + 1} / ${total}`;
    const pct = total <= 1 ? 100 : (posIdx / (total - 1)) * 100;
    (document.getElementById("progress-fill") as HTMLElement).style.width =
        pct + "%";
    (document.getElementById("progress-thumb") as HTMLElement).style.left =
        `clamp(7px, ${pct}%, calc(100% - 7px))`;
    (document.getElementById("btn-prev") as HTMLButtonElement).disabled =
        posIdx === 0;
    (document.getElementById("btn-next") as HTMLButtonElement).disabled =
        posIdx === total - 1;
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

        html += `<div class="frame" id="fr-active-${fi}" data-label="${frame.label}">${frameSlots}</div>`;
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
        html += `<span class="flabel" style="top:${top}px">${frame.label}</span>`;
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

// ─── Asm mode switcher ────────────────────────────────────────────────────
function switchAsmMode(mode: "source" | "assembled"): void {
    _asmMode = mode;
    if (mode === "source") {
        // Snap cur down to the nearest source boundary so we never land
        // on an intermediate concrete step that has no row in source view.
        cur = _sourcePositions[currentSourcePosIdx()]!;
        buildAsmView(_assembled!);
    } else {
        buildAssembledView(_assembled!);
    }
    buildTicks();
    render(STEPS[cur]!);
    document.getElementById("btn-mode-source")!.classList.toggle("active", mode === "source");
    document.getElementById("btn-mode-assembled")!.classList.toggle("active", mode === "assembled");
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
let _asmMode: "source" | "assembled" = "source";
let _sourcePositions: number[] = []; // [0, sourceToConcrete[0], ...]
let _assembled: AssemblyResult | null = null;

function goTo(idx: number): void {
    cur = Math.max(0, Math.min(STEPS.length - 1, idx));
    render(STEPS[cur]!);
}

function currentSourcePosIdx(): number {
    let p = 0;
    for (let i = _sourcePositions.length - 1; i >= 0; i--) {
        if (_sourcePositions[i]! <= cur) { p = i; break; }
    }
    return p;
}

function go(dir: number): void {
    if (_asmMode === "assembled") { goTo(cur + dir); return; }
    const p = currentSourcePosIdx();
    const newP = Math.max(0, Math.min(_sourcePositions.length - 1, p + dir));
    goTo(_sourcePositions[newP]!);
}

// ─── Program loader ───────────────────────────────────────────────────────
function buildTicks(): void {
    bar.querySelectorAll(".step-tick").forEach((el) => el.remove());
    if (_asmMode === "source") {
        const n = _sourcePositions.length;
        for (let i = 1; i < n - 1; i++) {
            const tick = document.createElement("div");
            tick.className = "step-tick";
            tick.style.left = (i / (n - 1)) * 100 + "%";
            bar.appendChild(tick);
        }
    } else {
        const n = STEPS.length;
        for (let i = 1; i < n - 1; i++) {
            const tick = document.createElement("div");
            tick.className = "step-tick";
            tick.style.left = (i / (n - 1)) * 100 + "%";
            bar.appendChild(tick);
        }
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
            `Instrucción desconocida: <code>${assembled.raw}</code> en etiqueta <code>${assembled.label}</code>.`,
        );
        return;
    }
    if (assembled instanceof RangeError) {
        showConfigError(
            `Salto fuera de rango: <code>${assembled.raw}</code> en etiqueta <code>${assembled.label}</code>.`,
        );
        return;
    }
    if (assembled instanceof ConfigError) {
        showConfigError(assembled.message);
        return;
    }
    if (assembled instanceof OverlapError) {
        showConfigError(
            `El código termina en <code>${hx(assembled.codeEnd)}</code>, que supera la base del stack <code>${hx(assembled.stackBase)}</code>.<br><br>` +
                `<span style="color:var(--text-dim)">Reduce <code>baseAddress</code> o ajusta <code>stackBase</code>.</span>`,
        );
        return;
    }

    // Validate that entryPoint names a defined label
    if (!(prog.entryPoint in assembled.labels)) {
        buildAsmView(assembled);
        showConfigError(
            `Punto de entrada <code>${prog.entryPoint}</code> no existe en las etiquetas definidas.<br><br>` +
                `<span style="color:var(--text-dim)">Etiquetas disponibles: ${Object.keys(assembled.labels)
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
    const { steps, sourceToConcrete } = simulate(prog, assembled);
    STEPS = steps;
    _sourcePositions = [0, ...sourceToConcrete];
    _assembled = assembled;
    _asmMode = "source";
    cur = 0;
    buildAsmView(assembled);
    render(STEPS[0]!);
    buildTicks();
    document.getElementById("btn-mode-source")!.classList.add("active");
    document.getElementById("btn-mode-assembled")!.classList.remove("active");
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
    if (_asmMode === "source") {
        const posIdx = Math.round(ratio * (_sourcePositions.length - 1));
        goTo(_sourcePositions[posIdx]!);
    } else {
        goTo(Math.round(ratio * (STEPS.length - 1)));
    }
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

    const targetEl = (e.target as Element | null)?.closest("[data-target-addr]") as HTMLElement | null;
    if (targetEl) {
        const addr = parseInt(targetEl.dataset["targetAddr"]!);
        document.getElementById(`al-${addr.toString(16)}`)?.classList.add("target-hl");
    }
});
document.addEventListener("mouseout", (e) => {
    if (!(e.target as Element | null)?.closest("[data-tooltip]")) return;
    tt.style.display = "none";
    document.querySelectorAll(".target-hl").forEach(el => el.classList.remove("target-hl"));
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
document.getElementById("btn-mode-source")!.addEventListener("click", () => switchAsmMode("source"));
document.getElementById("btn-mode-assembled")!.addEventListener("click", () => switchAsmMode("assembled"));
document
    .getElementById("tab-asm")!
    .addEventListener("click", () => switchTab("asm"));
document
    .getElementById("tab-c")!
    .addEventListener("click", () => switchTab("c"));
