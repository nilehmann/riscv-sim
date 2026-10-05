import type { TypedNode } from "./ctypes";
import { leavesOf, internalNodes } from "./ctypes";
import type { MemAccess } from "./isa/types";
import { overlapsAccess } from "./memUtils";

// ─── Grid layout of a typed memory region ─────────────────────────────────
// All leaf values sit in one row (one grid column each). Every struct/array
// node is a card spanning its leaves' columns, from the value row down to its
// footer. Inner cards end above the cards that contain them.

export interface LeafCell {
  leaf: TypedNode;
  /** 1-based grid column. */
  col: number;
  /** Whether the leaf's name is shown under it. */
  labelled: boolean;
  /** First leaf of an outermost card. */
  outerStart: boolean;
  /** First leaf of a visible inner card (and not of an outermost one). */
  innerStart: boolean;
}

export interface CardCell {
  node: TypedNode;
  col: number;
  span: number;
  /** Last grid row the card covers (1-based, inclusive). */
  lastRow: number;
  outer: boolean;
  open: boolean;
  /** Address (outermost) or "+offset" from the outermost card's start (inner). */
  where: string;
}

export interface RegionLayout {
  leaves: LeafCell[];
  cards: CardCell[];
  /** Whether the row of leaf names exists. */
  labelRow: boolean;
  /** Number of footer rows below the values (and labels). */
  footerRows: number;
}

/**
 * Lays out `root`. `open` holds the paths of expanded cards; `fmtAddr`
 * formats an outermost card's address.
 */
export function layoutRegion(
  root: TypedNode,
  open: ReadonlySet<string>,
  fmtAddr: (addr: number) => string,
): RegionLayout {
  const leaves = leavesOf(root);
  const col = new Map(leaves.map((l, i) => [l, i + 1]));
  const parent = new Map<TypedNode, TypedNode>();
  (function link(n: TypedNode) {
    for (const c of n.children ?? []) {
      parent.set(c, n);
      link(c);
    }
  })(root);

  // A lone struct is its own outermost card; an array's elements are the
  // outermost cards; a scalar array has no cards at all.
  const isStruct = root.type?.kind === "struct";
  const cards = internalNodes(root).filter((n) => n !== root || isStruct);
  const isCard = new Set(cards);
  const outerDepth = isStruct ? 0 : 1;
  const expanded = (n: TypedNode) => !isCard.has(n) || open.has(n.path);
  const visible = (n: TypedNode) => {
    for (let p = parent.get(n); p; p = parent.get(p)) if (!expanded(p)) return false;
    return true;
  };

  const shown = cards.filter(visible);
  const outerOf = (n: TypedNode): TypedNode => {
    let m = n;
    while (m.depth > outerDepth) m = parent.get(m)!;
    return m;
  };

  const outerStarts = new Set(cards.filter((n) => n.depth === outerDepth).map((n) => leavesOf(n)[0]!));
  const innerStarts = new Set(shown.filter((n) => n.depth > outerDepth).map((n) => leavesOf(n)[0]!));

  const leafCells: LeafCell[] = leaves.map((leaf) => ({
    leaf,
    col: col.get(leaf)!,
    labelled: visible(leaf),
    outerStart: outerStarts.has(leaf),
    innerStart: !outerStarts.has(leaf) && innerStarts.has(leaf),
  }));

  const labelRow = leafCells.some((c) => c.labelled);
  const maxDepth = Math.max(outerDepth, ...shown.map((n) => n.depth));
  const footerRows = shown.length ? maxDepth - outerDepth + 1 : 0;
  const base = labelRow ? 2 : 1;

  const cardCells: CardCell[] = shown.map((node) => {
    const ls = leavesOf(node);
    const outer = node.depth === outerDepth;
    return {
      node,
      col: col.get(ls[0]!)!,
      span: ls.length,
      // Deepest visible cards close first.
      lastRow: base + (maxDepth - node.depth) + 1,
      outer,
      open: open.has(node.path),
      where: outer ? fmtAddr(node.addr) : `+${node.addr - outerOf(node).addr}`,
    };
  });

  return { leaves: leafCells, cards: cardCells, labelRow, footerRows };
}

/** Whether a leaf overlaps any of the accesses. */
export function isAccessed(leaf: TypedNode, access: readonly MemAccess[] | undefined): boolean {
  return overlapsAccess(leaf.addr, leaf.size, access);
}
