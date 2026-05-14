# C++ Reversing

## Name Demangling
```bash
c++filt '_ZN4Game6Player7getNameEv'     # → Game::Player::getName()
c++filt '_ZNSt6vectorIiSaIiEE9push_backERKi'  # → std::vector<int>::push_back(int const&)
# IDA: Options → Demangled names → Show
# Ghidra: auto-demangles in decompiler output
```
Mangling scheme: `_Z` prefix (Itanium ABI / GCC/Clang), `?` prefix (MSVC).

## Virtual Function Tables (vtables)

### Recognition in Assembly
```asm
; Object construction — vtable pointer written to object start
mov rax, offset vtable_for_Player    ; load vtable address
mov [rdi], rax                        ; store at object[0]

; Virtual call — double dereference
mov rax, [rdi]           ; load vtable pointer from object
call [rax + 0x10]        ; call vtable[2] (3rd virtual function)
; rdi = this pointer (first implicit argument)
```

### Vtable Layout
```
vtable_for_Player:
  +0x00: typeinfo pointer (RTTI)
  +0x08: ~Player() (destructor)
  +0x10: Player::update()        ← vtable[2]
  +0x18: Player::getName()       ← vtable[3]
  ...
```

### Reconstructing Class Hierarchy
```python
# In IDA: find all vtable references
# 1. Search for "vtable" or "typeinfo" strings
# 2. Cross-reference the vtable address → find constructors
# 3. Constructor writes vtable ptr → reveals which class
# 4. Multiple vtable writes in one constructor → inheritance chain
# 5. Rename vtable entries based on call patterns

# Ghidra: Window → Virtual Function Table → auto-detected vtables
```

## RTTI (Run-Time Type Information)
**When**: Binary not compiled with `-fno-rtti`. GCC/Clang leave typeinfo structures.
```
typeinfo for Player:
  +0x00: pointer to typeinfo vtable (std::type_info)
  +0x08: pointer to mangled name string ("4Game6Player")
  +0x10: pointer to parent typeinfo (if inherited)
```
```bash
# Find class names from typeinfo
strings binary | grep -E '^[0-9]+[A-Z][a-z]'  # mangled type names
# Or search for "typeinfo for" / "typeinfo name for" in IDA symbols
```

### IDA Class Informer Plugin
Reconstructs class hierarchies from RTTI: `Edit → Plugins → Class Informer`.

## STL Container Layouts (64-bit GCC)

| Container | Memory Layout | sizeof |
|---|---|---|
| `std::string` | `{char* ptr, size_t len, size_t cap}` or SSO (≤15 chars inline) | 32 |
| `std::vector<T>` | `{T* begin, T* end, T* capacity_end}` | 24 |
| `std::map<K,V>` | Red-black tree node: `{color, parent, left, right, key, value}` | 48 |
| `std::unordered_map` | Hash table: `{bucket_array*, bucket_count, size, ...}` | 56 |
| `std::shared_ptr<T>` | `{T* ptr, control_block*}` | 16 |
| `std::unique_ptr<T>` | `{T* ptr}` | 8 |
| `std::function` | `{vtable_ptr, callable_storage[16]}` | 32 |

### std::string SSO (Short String Optimization)
```
If len ≤ 15: string data stored inline (no heap allocation)
Layout: [data[0..14]] [len | 0x80 flag if heap]
If len > 15: [char* heap_ptr] [size] [capacity]
```

## new / delete Recognition
```asm
; operator new(size) → calls malloc-like function
call _Znwm              ; operator new(unsigned long)
; operator delete(ptr) → calls free-like function
call _ZdlPv             ; operator delete(void*)
; operator new[](size) → array version
call _Znam              ; operator new[](unsigned long)
```

## Exception Handling
```asm
; try/catch compiles to:
; .gcc_except_table contains LSDA (Language Specific Data Area)
; __cxa_throw(exception_obj, typeinfo, destructor) — throw
; __cxa_begin_catch / __cxa_end_catch — catch block boundaries
; Personality routine: __gxx_personality_v0
```
Look for `__cxa_throw` calls to find where exceptions originate, `__cxa_begin_catch` for handler entry points.

## Templates
Templates are fully instantiated at compile time — each specialization is a separate function. `std::sort<int>` and `std::sort<string>` are different functions. The demangled name reveals the template parameters.

## Trap
- MSVC and GCC have different vtable layouts, name mangling, and exception handling. Check the compiler first.
- Virtual inheritance adds an extra vbase offset table — more complex vtable layout.
- Optimized builds may devirtualize calls (replace virtual dispatch with direct call if the type is known at compile time).
