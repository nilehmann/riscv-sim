import type { Program } from "./types";

/** Loaded at startup, before any example is picked. */
export const EMPTY_PROGRAM: Program = {
  name: "New program",
  initialRegs: {},
  baseAddress: 0x8000,
  assembly: "",
  showStack: false,
};

export const PROGRAMS: Program[] = [
  {
    name: "load big immediate",
    folder: "Basics",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000 },
    baseAddress: 0x8000,
    assembly: `\
foo:
    li  a0, 4097
    ret`,
  },
  {
    name: "Conditional jump",
    folder: "Basics",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0 },
    baseAddress: 0x8000,
    assembly: `\
foo:
    beq a0, zero, .L0
    addi a0, a0, 1
.L0:
    addi a0, a0, 2
    ret`,
  },
  {
    name: "Store a byte",
    folder: "Basics",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000 },
    baseAddress: 0x8000,
    cCode: `\
int baz(char *c) {
    return *c;
}

int foo() {
  char c = 42;
  return baz(&c);
}
`,
    assembly: `\
baz:
        lbu     a0,0(a0)
        ret
foo:
        addi    sp,sp,-32
        sw      ra,28(sp)
        li      a5,42
        sb      a5,15(sp)
        addi    a0,sp,15
        call    baz
        lw      ra,28(sp)
        addi    sp,sp,32
        jr      ra
      `,
  },
  {
    name: "baz -> foo",
    folder: "Function calls",
    cCode: `int foo(int x) {\n    return x + 1;\n}\n\nint baz(int y) {\n    return foo(1) + y;\n}`,
    entryPoint: "baz",
    initialRegs: { sp: 0xbfffff00, ra: 0x8050, a0: 3, s0: 0x54 },
    baseAddress: 0x8000,
    assembly: `\
foo:
    addi a0, a0, 1
    ret

baz:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    mv   s0, a0
    li   a0, 1
    call foo
    add  a0, a0, s0
    lw   ra, 12(sp)
    lw   s0, 8(sp)
    addi sp, sp, 16
    ret`,
  },
  {
    name: "bar -> foo -> baz",
    folder: "Function calls",
    entryPoint: "bar",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 3, s0: 0x54 },
    baseAddress: 0x8000,
    assembly: `\
baz:
    add  a0, a0, a1
    ret

foo:
    addi sp, sp, -16
    sw   ra, 12(sp)
    li   a1, 0
    call baz
    addi a0, a0, 1
    lw   ra, 12(sp)
    addi sp, sp, 16
    ret

bar:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    mv   s0, a0
    li   a0, -1
    call foo
    add  a0, a0, s0
    lw   ra, 12(sp)
    lw   s0, 8(sp)
    addi sp, sp, 16
    ret`,
  },
  {
    name: "Local variable",
    folder: "Stack and locals",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 1 },
    baseAddress: 0x8000,
    cCode: `\
int baz(int *n) {
    return *n;
}

int foo() {
  int x = 42;
  return baz(&x);
}`,
    assembly: `\
baz:
  lw      a0,0(a0)
  ret
foo:
  addi    sp,sp,-32
  sw      ra,28(sp)
  li      a5,42
  sw      a5,12(sp)
  addi    a0,sp,12
  call    baz
  lw      ra,28(sp)
  addi    sp,sp,32
  jr      ra`,
  },
  {
    name: "Static array",
    folder: "Stack and locals",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 1 },
    baseAddress: 0x8000,
    cCode: `\
int foo(int i) {
  int arr[] = {0, 1, 2};
  return arr[i];
}
    `,
    assembly: `\
foo:
  addi    sp,sp,-16
  sw      zero,4(sp)
  li      a5,1
  sw      a5,8(sp)
  li      a5,2
  sw      a5,12(sp)
  slli    a0,a0,2
  addi    a5,sp,16
  add     a0,a5,a0
  lw      a0,-12(a0)
  addi    sp,sp,16
  jr      ra`,
  },
  {
    name: "Dynamic array",
    folder: "Stack and locals",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 3 },
    baseAddress: 0x8000,
    cCode: `\
void foo(int n) {
  int arr[n];
  arr[0] = 42;
}
    `,
    assembly: `\
  foo:
      addi    sp, sp, -16
      sw      ra, 12(sp)
      sw      s0, 8(sp)
      addi    s0, sp, 16
      slli    a5, a0, 2
      addi    a5, a5, 15
      andi    a5, a5, -16
      sub     sp, sp, a5
      li      a4, 42
      sw      a4, 0(sp)
      addi    sp, s0, -16
      lw      ra, 12(sp)
      lw      s0, 8(sp)
      addi    sp, sp, 16
      jr      ra`,
  },
  {
    name: "Array on the heap",
    folder: "Heap",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0x10000, a1: 2 },
    baseAddress: 0x8000,
    memoryRegions: [
      { addr: 0x10000, decl: "int arr[4]", init: [10, 20, 30, 40] },
    ],
    cCode: `\
// arr = malloc(4 * sizeof(int)), holding {10, 20, 30, 40}
int foo(int *arr, int i) {
    arr[i] = arr[i] * 2;
    return arr[i];
}`,
    assembly: `\
foo:
    slli    a1, a1, 2
    add     a0, a0, a1
    lw      a4, 0(a0)
    slli    a4, a4, 1
    sw      a4, 0(a0)
    mv      a0, a4
    ret`,
  },
  {
    name: "Struct field",
    folder: "Heap",
    entryPoint: "get_y",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0x10000, a1: 1 },
    baseAddress: 0x8000,
    showStack: false,
    types: `typedef struct {
  int x;
  int y;
} Point;`,
    memoryRegions: [
      { addr: 0x10000, decl: "Point pts[3]", init: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] },
    ],
    cCode: `\
typedef struct {
  int x;
  int y;
} Point;

// pts = malloc(3 * sizeof(Point)), holding {{1, 2}, {3, 4}, {5, 6}}
int get_y(Point *pts, int i) {
  return pts[i].y;
}`,
    assembly: `\
get_y:
    slli    a1, a1, 3
    add     a0, a0, a1
    lw      a0, 4(a0)
    ret`,
  },
  {
    name: "Struct padding",
    folder: "Heap",
    entryPoint: "get_x",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0x10000, a1: 1 },
    baseAddress: 0x8000,
    showStack: false,
    types: `struct S {
  char c;   // +0
  int  x;   // +4 (3 bytes padding)
};`,
    memoryRegions: [
      { addr: 0x10000, decl: "struct S s[2]", init: [{ c: 0x41, x: 7 }, { c: 0x42, x: 9 }] },
    ],
    cCode: `\
struct S {
  char c;   // +0
  int  x;   // +4 (3 bytes padding)
};

// s = malloc(2 * sizeof(struct S)), holding {{'A', 7}, {'B', 9}}
int get_x(struct S *s, int i) {
  return s[i].x;
}`,
    assembly: `\
get_x:
    slli    a1, a1, 3
    add     a0, a0, a1
    lw      a0, 4(a0)
    ret`,
  },
  {
    name: "Padding before a struct",
    folder: "Heap",
    entryPoint: "get",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0x10000, a1: 1 },
    baseAddress: 0x8000,
    showStack: false,
    types: `typedef struct {
  int x;
  int y;
} Point;

struct Item {
  char  kind;  // +0, then 3 bytes padding
  Point pos;   // +4 (Point is 4-aligned)
};`,
    memoryRegions: [
      {
        addr: 0x10000,
        decl: "struct Item items[2]",
        init: [{ kind: 0x61, pos: { x: 5, y: 6 } }, { kind: 0x62, pos: { x: 7, y: 8 } }],
      },
    ],
    cCode: `\
typedef struct {
  int x;
  int y;
} Point;

struct Item {
  char  kind;  // +0, then 3 bytes padding
  Point pos;   // +4 (Point is 4-aligned)
};             // sizeof = 12

// it = malloc(2 * sizeof(struct Item)), holding {{'a', {5, 6}}, {'b', {7, 8}}}
int get(struct Item *it, int i) {
  return it[i].pos.y;  // 4 + 4 = 8
}`,
    assembly: `\
get:
    slli    a5, a1, 1
    add     a5, a5, a1
    slli    a5, a5, 2
    add     a0, a0, a5
    lw      a0, 8(a0)
    ret`,
  },
  {
    name: "Nested struct",
    folder: "Heap",
    entryPoint: "top",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0x10000, a1: 1 },
    baseAddress: 0x8000,
    showStack: false,
    types: `typedef struct {
  int x;
  int y;
} Point;

typedef struct {
  Point min;   // +0
  Point max;   // +8
} Rect;`,
    memoryRegions: [
      {
        addr: 0x10000,
        decl: "Rect rects[2]",
        init: [
          { min: { x: 0, y: 0 }, max: { x: 4, y: 3 } },
          { min: { x: 1, y: 1 }, max: { x: 9, y: 7 } },
        ],
      },
    ],
    cCode: `\
typedef struct {
  int x;
  int y;
} Point;

typedef struct {
  Point min;   // +0
  Point max;   // +8
} Rect;

// r = malloc(2 * sizeof(Rect)), holding {{{0, 0}, {4, 3}}, {{1, 1}, {9, 7}}}
int top(Rect *r, int i) {
  return r[i].max.y;   // 8 + 4 = 12
}`,
    assembly: `\
top:
    slli    a1, a1, 4
    add     a0, a0, a1
    lw      a0, 12(a0)
    ret`,
  },
  {
    name: "Array in struct",
    folder: "Heap",
    entryPoint: "get",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 0x10000, a1: 1 },
    baseAddress: 0x8000,
    showStack: false,
    types: `typedef struct {
  int x;
  int y;
} Point;

typedef struct {
  int   n;      // +0
  Point v[2];   // +4
} Poly;`,
    memoryRegions: [
      { addr: 0x10000, decl: "Poly poly", init: { n: 2, v: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } },
    ],
    cCode: `\
typedef struct {
  int x;
  int y;
} Point;

typedef struct {
  int   n;      // +0
  Point v[2];   // +4
} Poly;

// p = malloc(sizeof(Poly)), holding {2, {{1, 2}, {3, 4}}}
int get(Poly *p, int i) {
  return p->v[i].y;   // 4 + i*8 + 4
}`,
    assembly: `\
get:
    slli    a1, a1, 3
    add     a0, a0, a1
    lw      a0, 8(a0)
    ret`,
  },
  {
    name: "baz -> foo",
    folder: "Function calls",
    isa: "x86",
    cCode: `int foo(int x) {\n    return x + 1;\n}\n\nint baz(int y) {\n    return foo(1) + y;\n}`,
    entryPoint: "baz",
    initialRegs: { rsp: 0x7fffffffef08, rbp: 0x7fffffffef30, rdi: 3 },
    baseAddress: 0x401000,
    returnAddress: 0x401200,
    // gcc -O0 -masm=intel
    assembly: `\
foo:
    push rbp
    mov  rbp, rsp
    mov  DWORD PTR [rbp-4], edi
    mov  eax, DWORD PTR [rbp-4]
    add  eax, 1
    pop  rbp
    ret

baz:
    push rbp
    mov  rbp, rsp
    sub  rsp, 8
    mov  DWORD PTR [rbp-4], edi
    mov  edi, 1
    call foo
    mov  edx, DWORD PTR [rbp-4]
    add  eax, edx
    leave
    ret`,
  },
];
