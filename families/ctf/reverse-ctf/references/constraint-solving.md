# Constraint Solving for Reverse Engineering

## Z3 (SMT Solver)

### Basic Usage

```python
from z3 import *

# Define symbolic variables
x = BitVec('x', 32)    # 32-bit bitvector
y = BitVec('y', 32)

s = Solver()
s.add(x + y == 100)
s.add(x > y)
s.add(x < 80)

if s.check() == sat:
    m = s.model()
    print(f"x = {m[x]}, y = {m[y]}")
```

### Recovering Flag from Validation

```python
from z3 import *

flag_len = 32
flag = [BitVec(f'f{i}', 8) for i in range(flag_len)]
s = Solver()

# Printable ASCII constraints
for b in flag:
    s.add(b >= 0x20, b <= 0x7e)

# Known prefix
s.add(flag[0] == ord('f'))
s.add(flag[1] == ord('l'))
s.add(flag[2] == ord('a'))
s.add(flag[3] == ord('g'))
s.add(flag[4] == ord('{'))

# Validation constraints (extracted from binary)
# Example: flag[5] ^ 0x42 == 0x30
s.add(flag[5] ^ 0x42 == 0x30)
# ... add all constraints from the binary

if s.check() == sat:
    m = s.model()
    result = ''.join(chr(m[f].as_long()) for f in flag)
    print(result)
```

### Bitvector Operations

```python
# Common operations matching x86 instructions
x = BitVec('x', 32)
y = BitVec('y', 32)

x + y           # ADD
x - y           # SUB
x * y           # IMUL
x & y           # AND
x | y           # OR
x ^ y           # XOR
~x              # NOT
x << 3          # SHL
LShR(x, 3)      # SHR (logical)
x >> 3          # SAR (arithmetic)
RotateLeft(x, 3)   # ROL
RotateRight(x, 3)  # ROR
ZeroExt(32, x)  # zero-extend to 64 bits
SignExt(32, x)  # sign-extend to 64 bits
Extract(7, 0, x)  # extract bits [7:0]
Concat(x, y)    # concatenate bitvectors
```

### Optimization

```python
# If you need to find a specific value (not just any solution)
o = Optimize()
o.add(constraints...)
o.minimize(some_expression)  # or maximize
o.check()
```

## angr (Symbolic Execution)

See `dynamic-analysis.md` for basic angr usage. Additional tips:

### Hooking Functions

```python
# Replace a complex function with a simple model
@proj.hook(addr, length=5)
def skip_function(state):
    state.regs.rax = 0  # force return value
```

### Avoiding Path Explosion

```python
# Limit exploration
simgr.explore(find=target, avoid=avoid_list, n=1)

# Use veritesting for loop handling
simgr = proj.factory.simgr(state, veritesting=True)

# Concretize when possible
state.options.add(angr.options.LAZY_SOLVES)
```

### Memory Model

```python
# Read symbolic memory
state.memory.load(addr, size)

# Write concrete memory
state.memory.store(addr, value)

# Add memory constraint
ptr = state.memory.load(addr, 8, endness='Iend_LE')
state.solver.add(ptr == 0x42)
```

## Manual Brute-Force

**When**: Key space is small enough to enumerate.

```python
# Byte-by-byte brute-force (e.g., checking each byte independently)
import subprocess

flag = bytearray(32)
for pos in range(32):
    for byte in range(0x20, 0x7f):
        flag[pos] = byte
        result = subprocess.run(['./binary'], input=bytes(flag),
                              capture_output=True, timeout=1)
        if b"correct" in result.stdout or result.returncode == 0:
            break
```

### Timing Side-Channel

```python
import time, subprocess

flag = bytearray(32)
for pos in range(32):
    best_byte, best_time = 0, 0
    for byte in range(0x20, 0x7f):
        flag[pos] = byte
        times = []
        for _ in range(10):
            start = time.perf_counter()
            subprocess.run(['./binary'], input=bytes(flag),
                         capture_output=True, timeout=1)
            times.append(time.perf_counter() - start)
        avg = sorted(times)[5]  # median
        if avg > best_time:
            best_byte, best_time = byte, avg
    flag[pos] = best_byte
    print(f"pos {pos}: {chr(best_byte)} ({best_time:.4f}s)")
```

## Instruction Counting Side-Channel
**When**: Binary checks input byte-by-byte and exits on first wrong byte — the number of executed instructions reveals how many bytes are correct. | **Trap**: works even when binary is heavily obfuscated.
```python
# IN: binary path, flag length  OUT: flag
import subprocess

flag = bytearray(flag_len)
for pos in range(flag_len):
    best_byte, best_count = 0, 0
    for b in range(0x20, 0x7f):
        flag[pos] = b
        result = subprocess.run(
            ['valgrind', '--tool=callgrind', '--callgrind-out-file=/dev/null',
             f'--log-file=/tmp/cg.log', './binary'],
            input=bytes(flag), capture_output=True, timeout=5
        )
        # Parse instruction count from Valgrind log
        with open('/tmp/cg.log') as f:
            for line in f:
                if 'Collected' in line:
                    count = int(''.join(c for c in line if c.isdigit()))
                    break
        if count > best_count:
            best_byte, best_count = b, count
    flag[pos] = best_byte
    print(f"pos {pos}: {chr(best_byte)} ({best_count} insns)")
print(f"Flag: {flag.decode()}")
```
**Alternative tools**: `perf stat -e instructions ./binary` (faster, Linux only), Intel Pin `inscount` tool, `qemu -d in_asm` (count lines).

## SAT Solvers

For purely boolean problems (e.g., circuit satisfiability):

```python
from pysat.solvers import Glucose3

g = Glucose3()
# Add clauses (CNF format)
g.add_clause([1, 2])       # x1 OR x2
g.add_clause([-1, 3])      # NOT x1 OR x3

if g.solve():
    print(g.get_model())   # satisfying assignment
```

## Constraint Extraction Tips

1. **From decompiled code**: translate each `if` condition into
   a Z3 constraint.
2. **From assembly**: map each comparison instruction to Z3.
3. **Array lookups**: model as `Select` on Z3 arrays or unroll.
4. **Loops**: unroll a fixed number of iterations if bounded.
5. **Custom crypto**: model the transformation symbolically,
   set output = known value, solve for input.
