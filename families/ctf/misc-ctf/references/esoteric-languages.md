# Esoteric Language Identification

| Character Set | Language | Interpreter |
|---|---|---|
| `+-><[].,` only | Brainfuck | `bf`, online |
| Whitespace only (spaces/tabs/LF) | Whitespace | `wspace`, online |
| `[]()!+` only | JSFuck | Browser console |
| `Ook. Ook! Ook?` | Ook! | Online |
| Color-coded image | Piet | npiet, online |
| `>v<^` with ASCII | Befunge | cfunge, online |
| Musical notation | Velato | Velato interpreter |
| `/**/` style | COW | Online |
| `+[.>` DNA-like sequences | DNA# | Online |
| `Chicken` repeated | Chicken | Online |
| `()()()` with letters | Malbolge | Online |
| Words from Shakespeare plays | Shakespeare | Online |
| Chef-like recipe format | Chef | Online |

## Brainfuck

```
+ - : increment/decrement current cell
> < : move pointer right/left
[ ] : loop while current cell != 0
.   : output current cell as ASCII
,   : input one byte
```

```python
# Simple Brainfuck interpreter
def bf(code, input_data=""):
    tape = [0] * 30000
    ptr = 0
    pc = 0
    inp = iter(input_data)
    output = []
    brackets = {}

    # Pre-compute bracket pairs
    stack = []
    for i, c in enumerate(code):
        if c == '[': stack.append(i)
        elif c == ']':
            j = stack.pop()
            brackets[i] = j
            brackets[j] = i

    while pc < len(code):
        c = code[pc]
        if c == '+': tape[ptr] = (tape[ptr] + 1) % 256
        elif c == '-': tape[ptr] = (tape[ptr] - 1) % 256
        elif c == '>': ptr += 1
        elif c == '<': ptr -= 1
        elif c == '.': output.append(chr(tape[ptr]))
        elif c == ',': tape[ptr] = ord(next(inp, '\0'))
        elif c == '[' and tape[ptr] == 0: pc = brackets[pc]
        elif c == ']' and tape[ptr] != 0: pc = brackets[pc]
        pc += 1
    return ''.join(output)
```

## JSFuck

JavaScript using only `[]()!+`. Runs in any browser console.

```javascript
// Paste the JSFuck code into browser console
// Or decode: JSFuck encodes characters via type coercion
// []  → "" (empty array to string)
// ![] → false
// +[] → 0
// +!+[] → 1
// (![]+[])[+!+[]] → "a" (from "false"[1])
```

## Whitespace

Only spaces, tabs, and linefeeds are significant. All other
characters are ignored (can hide in normal-looking text).

```
Space = 0, Tab = 1 (in binary encoding)
Three IMP (Instruction Modification Parameter) types:
- Stack manipulation
- Arithmetic
- Heap access, I/O, flow control
```

## Piet

Image-based language where colors represent instructions.
The interpreter moves through the image following color transitions.

```bash
npiet image.png                         # run Piet program
```

## Decoding Strategy

1. Identify the language from character set / visual appearance
2. Use an online interpreter to run the program
3. If the program takes input, try common inputs (flag format, etc.)
4. Some challenges hide esolang code inside other data (e.g.,
   Whitespace in a Python script's indentation)
