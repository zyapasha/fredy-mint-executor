# fredy-mint-executor

> One-shot NFT mint across multiple EVM wallets in parallel. Auto chain detect, function probe, gas budget, broadcast, consolidate.

Built as a component of [FREDY](https://github.com/zyapasha/fredy-mint-executor#about-fredy), an autonomous Web3 + dev-ops agent running on the [Hermes Agent](https://hermes-agent.nousresearch.com) framework. This repo extracts the mint pipeline as a standalone CLI so anyone can use it.

## What it does

You point it at an NFT contract address. It:

1. **Detects which chain the contract is on** — Ethereum, Base, Arbitrum, Optimism (via `eth_getCode`)
2. **Loads agent wallets from an encrypted secret store** (GPG AES256, never written to disk)
3. **Preflight per wallet in parallel**:
   - Balance check + EOA verification (no EIP-7702 delegate)
   - Function probe: tries `mint(uint256)`, `publicMint(uint256)`, `claim(uint256)`, `mint()` via `estimateGas`
   - Gas budget calculation: `maxFeePerGas = balance / gasLimit`
4. **Surfaces blockers in one message** — e.g. "wallet X needs +0.0001 ETH top-up" — instead of per-wallet ping-pong
5. **Broadcasts in parallel** — every ready wallet fires its tx concurrently
6. **Consolidates the minted NFTs** to a destination wallet (default: configurable burn/cold wallet) via `safeTransferFrom` (or `transferFrom` if dest has code)

End-to-end ~10 seconds from invocation to broadcast on a 5-wallet fleet.

## Why

For first-come-first-served (FCFS) NFT mints, the bottleneck isn't compute — it's the human in the loop. Tools that need you to:

- copy the contract address into a UI
- click "estimate gas"
- check if the wallet has enough
- wait, switch wallet, repeat
- transfer the NFT to your cold wallet manually

…lose to bots that took 200ms to do all of it. This is the bot version, but transparent and open-source.

It also handles the boring failure modes:

- Free mint where `getFeeData()` returns a `maxFeePerGas` higher than your wallet balance → script overrides with `balance/gasLimit` so the wallet's full balance becomes the gas budget. Tx still mines at `effectiveGasPrice = baseFee + tip`, refunding the overage.
- Wallet with EIP-7702 delegate code → skipped from `_safeMint` contracts (would revert `ERC721InvalidReceiver`).
- Already-minted wallet → `estimateGas` reverts, wallet auto-skipped.
- RPC rate limit → tries 4 chains in parallel, picks first that responds with code.

## Install

```bash
git clone https://github.com/zyapasha/fredy-mint-executor.git
cd fredy-mint-executor
npm install
```

Requires Node.js 20+ and GnuPG.

## Setup the secret store

```bash
# 1. Create the secret bundle (one-time)
mkdir -p ~/.config/mint-executor
cat > /tmp/wallets.txt << 'EOF'
# Format: <label>-<field>=<value>
# Field is one of: address, mnemonic, pk, derivation
airdrop-01-address=0xYourEvmAddress
airdrop-01-mnemonic=word1 word2 word3 ... word12
airdrop-01-derivation=m/44'/60'/0'/0/0
EOF

# 2. Generate a passphrase file
openssl rand -base64 32 | tr -d '\n' > ~/.config/mint-executor/.key
chmod 400 ~/.config/mint-executor/.key

# 3. Encrypt and remove plaintext
gpg --batch --yes --passphrase-file ~/.config/mint-executor/.key --pinentry-mode loopback \
    --symmetric --cipher-algo AES256 \
    --output ~/.config/mint-executor/wallets.gpg /tmp/wallets.txt
shred -u /tmp/wallets.txt
chmod 600 ~/.config/mint-executor/wallets.gpg
```

The script reads `wallets.gpg` decrypted in-memory only. Plaintext never touches disk after step 3.

## Usage

```bash
# Full auto: detect chain, probe fn, mint with all wallets, consolidate to default destination
node mint.js 0xCONTRACT

# Preflight only, no broadcast
node mint.js 0xCONTRACT --dry

# Mint 2 per wallet
node mint.js 0xCONTRACT --qty=2

# Force a chain (skip auto-detect)
node mint.js 0xCONTRACT --chain=base

# Force a mint function name
node mint.js 0xCONTRACT --fn=publicMint

# Filter wallets by label suffix
node mint.js 0xCONTRACT --wallets=01,02

# Skip consolidation (leave NFTs in minting wallet)
node mint.js 0xCONTRACT --no-consolidate

# Send minted NFTs to a custom destination
node mint.js 0xCONTRACT --to=0xCustomColdWallet
```

## Output example

```
[detect] probing 0xc057... on 4 chains
[detect] ✓ found on ethereum (chainId 1, code 44924 chars)

[chain] ethereum
[contract] 0xc057...  qty 1

[wallets] 2: airdrop-01, airdrop-02

[probe] mint(uint256) works (gas 106130)
[probe] mint(uint256) works (gas 106130)

======================================================================
PREFLIGHT
======================================================================
  ✓ airdrop-01  bal=0.0000500 ETH  fn=mint  cost=0.0000378 ETH  maxFee=0.300g
  ✓ airdrop-02  bal=0.0000500 ETH  fn=mint  cost=0.0000378 ETH  maxFee=0.300g
======================================================================
Ready: 2/2

======================================================================
BROADCAST
======================================================================
  airdrop-01: tx 0xfb44...
  airdrop-01: ✓ block 25106034  tokens [5665]
  airdrop-02: tx 0x39ff...
  airdrop-02: ✓ block 25106035  tokens [5733]

======================================================================
CONSOLIDATE → 0xColdWallet...
======================================================================
[consolidate] using safeTransferFrom (dest code: EOA)
  airdrop-01 token 5665: ✓ block 25106074
  airdrop-02 token 5733: ✓ block 25106075
```

## Configuration

Optional `~/.config/mint-executor/config.json`:

```json
{
  "secretFile": "~/.config/mint-executor/wallets.gpg",
  "passphraseFile": "~/.config/mint-executor/.key",
  "defaultConsolidationTarget": "0xYourColdWallet",
  "chains": {
    "ethereum": "https://your.preferred.rpc",
    "base":     "https://mainnet.base.org",
    "arbitrum": "https://arb1.arbitrum.io/rpc",
    "optimism": "https://mainnet.optimism.io"
  }
}
```

## Security notes

- **Never commit your `wallets.gpg`, `.key`, or any plaintext mnemonic.** `.gitignore` covers the standard locations.
- The script never logs PKs or mnemonics to stdout. Only addresses, tx hashes, and balances appear in output.
- Pre-EIP-7702 (Pectra) chains are unaffected by the EOA check; the script only reads code length.
- The consolidate destination wallet is checked for code before deciding `safeTransferFrom` vs `transferFrom`. If your cold wallet is a Safe / Argent / Gnosis multisig, `transferFrom` is used — confirm it's the intended behavior.

Past failure mode this avoids: free-mint scripts that hardcode `getFeeData()` will revert with "insufficient funds for intrinsic transaction cost" on tight balances, even when the actual mint would have only consumed half the budget. The fix is to compute `maxFeePerGas = balance / gasLimit` so the budget never exceeds what's available; the EIP-1559 protocol refunds the overage at `effectiveGasPrice`.

## About FREDY

This script is one piece of a larger autonomous agent stack:

- **Telethon listener** monitors curated Web3 alpha sources, classifies leads, forwards to a private channel
- **9router** — multi-LLM router (Claude, GPT, MiMo) with priority fallback and quota-aware backoff
- **Hermes Agent** — orchestration layer with persistent memory, 100+ skills, and EIP-7702 / Sourcify preflight
- **mint-executor** (this repo) — the broadcast pipeline

7-day production usage as of mid-May 2026: ~6,000 LLM requests, 90M input tokens, 3 successful NFT mints across 3 wallets on Ethereum mainnet.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

PRs welcome for:

- More chains (zkSync, Linea, Scroll, Polygon zkEVM, Blast)
- More mint function patterns (signature-gated, merkle proof, mintWithReferral)
- Hardware wallet support (Ledger via `@ledgerhq/hw-app-eth`)
- Solana counterpart (Metaplex Candy Machine V3)

## Disclaimer

Use at your own risk. Minting NFTs and broadcasting transactions costs real money. The script does not audit contract code beyond function probing — for paid mints, run a full audit (Sourcify verification, source review for footguns) before pointing this at the contract. The author is not responsible for funds lost to malicious contracts, MEV, or your own configuration mistakes.
