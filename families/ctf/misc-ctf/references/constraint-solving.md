# Constraint Solving for Misc Challenges

## Z3 SMT Solver

```python
from z3 import *

# Integer constraints
x, y = Ints('x y')
s = Solver()
s.add(x + y == 42)
s.add(x > 0, y > 0)
s.add(x != y)
if s.check() == sat:
    print(s.model())

# Boolean / Logic puzzles
a, b, c = Bools('a b c')
s = Solver()
s.add(Or(a, b))           # a OR b
s.add(Not(And(a, c)))     # NOT (a AND c)
s.add(Implies(b, c))      # b IMPLIES c
if s.check() == sat:
    print(s.model())

# Bitvector (matching binary operations)
x = BitVec('x', 32)
s = Solver()
s.add((x >> 4) ^ x == 0xdeadbeef)
if s.check() == sat:
    print(hex(s.model()[x].as_long()))
```

## Common Puzzle Types

### Sudoku

```python
from z3 import *
cells = [[Int(f'c{r}{c}') for c in range(9)] for r in range(9)]
s = Solver()

# Each cell 1-9
for r in range(9):
    for c in range(9):
        s.add(cells[r][c] >= 1, cells[r][c] <= 9)

# Row, column, box uniqueness
for i in range(9):
    s.add(Distinct(cells[i]))                    # rows
    s.add(Distinct([cells[r][i] for r in range(9)]))  # columns

for br in range(3):
    for bc in range(3):
        box = [cells[br*3+r][bc*3+c] for r in range(3) for c in range(3)]
        s.add(Distinct(box))

# Add known values
# s.add(cells[0][0] == 5)
```

### N-Queens

```python
from z3 import *
n = 8
queens = [Int(f'q{i}') for i in range(n)]
s = Solver()
for i in range(n):
    s.add(queens[i] >= 0, queens[i] < n)
s.add(Distinct(queens))
for i in range(n):
    for j in range(i+1, n):
        s.add(queens[i] - queens[j] != i - j)
        s.add(queens[i] - queens[j] != j - i)
```

### Nonogram / Picross

```python
# Model each cell as boolean, add constraints for row/column runs
```

## Optimization Problems

```python
from z3 import *
o = Optimize()
x, y = Ints('x y')
o.add(x >= 0, y >= 0)
o.add(2*x + y <= 20)
o.add(x + 3*y <= 30)
o.maximize(3*x + 5*y)
if o.check() == sat:
    print(o.model())
```

## Brute Force (Small Key Space)

```python
from itertools import product

# Brute-force a 4-digit PIN
for pin in product('0123456789', repeat=4):
    candidate = ''.join(pin)
    if verify(candidate):
        print(f"Found: {candidate}")
        break

# Brute-force with pruning
from itertools import permutations
for perm in permutations(range(10), 5):
    if check_constraint(perm):
        print(perm)
        break
```

## Game Theory

### Sprague-Grundy

For impartial games (Nim-like):

```python
# Compute Grundy values
def grundy(state, memo={}):
    if state in memo:
        return memo[state]
    reachable = set()
    for next_state in moves(state):
        reachable.add(grundy(next_state, memo))
    g = 0
    while g in reachable:
        g += 1
    memo[state] = g
    return g

# Winning position if grundy(state) != 0
# Losing position if grundy(state) == 0
```

### Nim

```python
# XOR all pile sizes
# If XOR = 0: losing position for current player
# If XOR != 0: winning position, reduce a pile to make XOR = 0
xor_sum = 0
for pile in piles:
    xor_sum ^= pile
```

## Linear Algebra

```python
import numpy as np

# Solve system of linear equations Ax = b
A = np.array([[2, 1], [1, 3]])
b = np.array([5, 10])
x = np.linalg.solve(A, b)

# Over GF(2) — binary linear algebra
# Use SageMath: matrix(GF(2), [...]).solve_right(vector(GF(2), [...]))
```

## Dynamic Programming

```python
# Classic knapsack
def knapsack(weights, values, capacity):
    n = len(weights)
    dp = [[0] * (capacity + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for w in range(capacity + 1):
            dp[i][w] = dp[i-1][w]
            if weights[i-1] <= w:
                dp[i][w] = max(dp[i][w], dp[i-1][w-weights[i-1]] + values[i-1])
    return dp[n][capacity]
```
