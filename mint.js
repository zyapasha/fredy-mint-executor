#!/usr/bin/env node
// FREDY mint-executor — one-shot NFT mint across all agent wallets
//
// Usage:
//   node mint.js <contract> [--qty=1] [--chain=auto] [--fn=mint] [--wallets=01,02] [--dry] [--no-consolidate] [--to=0x...]
//
// Defaults:
//   - chain auto-detect (Ethereum, Base, Arbitrum, Optimism)
//   - quantity 1
//   - fn signature auto-probed: mint(uint256), publicMint(uint256), claim(uint256), mint()
//   - wallets: all agent wallets with secrets in agent-secrets/
//   - consolidate: ON, send minted tokens to wallet-burn after success
//
// Reads secrets ONLY from the configured GPG-encrypted bundle (default: ~/.config/mint-executor/wallets.gpg).
// Decrypts in-memory, never writes plaintext to disk.

const {HDNodeWallet, JsonRpcProvider, Contract, getAddress, isAddress, Interface} = require("ethers");
const {execSync} = require("child_process");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================
const CHAINS = {
  ethereum: { id: 1, rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io/tx/" },
  base:     { id: 8453, rpc: "https://mainnet.base.org", explorer: "https://basescan.org/tx/" },
  arbitrum: { id: 42161, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io/tx/" },
  optimism: { id: 10, rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io/tx/" },
};

const SECRET_FILE = process.env.MINT_EXECUTOR_SECRET || `${process.env.HOME}/.config/mint-executor/wallets.gpg`;
const BACKUP_KEY  = process.env.MINT_EXECUTOR_KEY    || `${process.env.HOME}/.config/mint-executor/.key`;
const WALLET_BURN_DEFAULT = process.env.MINT_EXECUTOR_DEFAULT_TO || null;

const MINT_FN_CANDIDATES = [
  { sig: "mint(uint256)", payload: (qty) => ({ args: [qty], abi: "function mint(uint256 quantity) external payable" }) },
  { sig: "publicMint(uint256)", payload: (qty) => ({ args: [qty], abi: "function publicMint(uint256 quantity) external payable" }) },
  { sig: "claim(uint256)", payload: (qty) => ({ args: [qty], abi: "function claim(uint256 quantity) external payable" }) },
  { sig: "mint()", payload: () => ({ args: [], abi: "function mint() external payable" }) },
];

// ============================================================
// ARGS
// ============================================================
const args = process.argv.slice(2);
const opts = {
  contract: null,
  qty: 1n,
  chain: "auto",
  fn: null,
  wallets: null,    // null = all
  dry: false,
  consolidate: true,
  to: WALLET_BURN_DEFAULT,
};

for (const a of args) {
  if (a.startsWith("0x") && a.length === 42) opts.contract = getAddress(a);
  else if (a.startsWith("--qty=")) opts.qty = BigInt(a.slice(6));
  else if (a.startsWith("--chain=")) opts.chain = a.slice(8);
  else if (a.startsWith("--fn=")) opts.fn = a.slice(5);
  else if (a.startsWith("--wallets=")) opts.wallets = a.slice(10).split(",");
  else if (a === "--dry") opts.dry = true;
  else if (a === "--no-consolidate") opts.consolidate = false;
  else if (a.startsWith("--to=")) opts.to = getAddress(a.slice(5));
}

  if (!opts.contract) {
  console.error("Usage: node mint.js <contract> [--qty=N] [--chain=auto|ethereum|base|arbitrum|optimism] [--fn=mint(uint256)] [--wallets=01,02] [--dry] [--no-consolidate] [--to=0x...]");
  process.exit(1);
}

if (opts.consolidate && !opts.to) {
  console.error("ERROR: consolidation requested but no destination set.");
  console.error("Either set MINT_EXECUTOR_DEFAULT_TO env var, or pass --to=0xCustom, or pass --no-consolidate.");
  process.exit(1);
}

// ============================================================
// HELPERS
// ============================================================
function loadSecrets() {
  const cmd = `gpg --batch --quiet --passphrase-file ${BACKUP_KEY} --pinentry-mode loopback --decrypt ${SECRET_FILE}`;
  let raw;
  try {
    raw = execSync(cmd, { stdio: ["pipe", "pipe", "ignore"] }).toString();
  } catch (e) {
    console.error(`FATAL: failed to decrypt ${SECRET_FILE}`);
    process.exit(1);
  }
  const wallets = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z0-9-]+)-(address|mnemonic|pk|derivation)=(.+)$/);
    if (!m) continue;
    const [, label, field, value] = m;
    wallets[label] = wallets[label] || { label };
    wallets[label][field] = value;
  }
  return Object.values(wallets);
}

async function detectChain(contract) {
  console.log(`[detect] probing ${contract} on ${Object.keys(CHAINS).length} chains…`);
  for (const [name, cfg] of Object.entries(CHAINS)) {
    try {
      const provider = new JsonRpcProvider(cfg.rpc);
      const code = await provider.getCode(contract);
      if (code && code !== "0x") {
        console.log(`[detect] ✓ found on ${name} (chainId ${cfg.id}, code ${code.length} chars)`);
        return name;
      }
    } catch (e) {
      console.log(`[detect] ${name}: rpc error (${e.shortMessage || e.message})`);
    }
  }
  console.error(`FATAL: contract ${contract} has no code on any supported chain`);
  process.exit(1);
}

async function probeMintFn(provider, contract, qty, signer) {
  // Try each candidate via estimateGas (fastest correctness check)
  for (const cand of MINT_FN_CANDIDATES) {
    const {args: fnArgs, abi} = cand.payload(qty);
    const c = new Contract(contract, [abi], signer);
    const fnName = abi.match(/function (\w+)/)[1];
    try {
      const gas = await c[fnName].estimateGas(...fnArgs);
      console.log(`[probe] ${cand.sig} works (gas ${gas})`);
      return { abi, fnName, args: fnArgs, gas };
    } catch (e) {
      const msg = (e.shortMessage || e.message || "").slice(0, 80);
      console.log(`[probe] ${cand.sig}: ${msg}`);
    }
  }
  return null;
}

function fmtETH(wei) { return `${(Number(wei) / 1e18).toFixed(7)} ETH`; }

// ============================================================
// MAIN
// ============================================================
(async () => {
  const chainName = opts.chain === "auto" ? await detectChain(opts.contract) : opts.chain;
  const cfg = CHAINS[chainName];
  if (!cfg) { console.error(`FATAL: unknown chain ${chainName}`); process.exit(1); }
  const provider = new JsonRpcProvider(cfg.rpc);
  console.log(`\n[chain] ${chainName} (${cfg.rpc})`);
  console.log(`[contract] ${opts.contract}  qty ${opts.qty}\n`);

  // Load secrets
  let allWallets = loadSecrets();
  if (opts.wallets) {
    allWallets = allWallets.filter(w => opts.wallets.some(x => w.label.endsWith(x)));
  }
  if (allWallets.length === 0) { console.error("FATAL: no wallets matched"); process.exit(1); }
  console.log(`[wallets] ${allWallets.length}: ${allWallets.map(w => w.label).join(", ")}\n`);

  // Phase 1: parallel preflight per wallet
  const preflightResults = await Promise.all(allWallets.map(async (wmeta) => {
    const w = HDNodeWallet.fromPhrase(wmeta.mnemonic, "", wmeta.derivation || "m/44'/60'/0'/0/0").connect(provider);
    const bal = await provider.getBalance(w.address);
    const code = await provider.getCode(w.address);
    const block = await provider.getBlock("latest");

    const result = {
      meta: wmeta,
      wallet: w,
      address: w.address,
      bal,
      baseFee: block.baseFeePerGas,
      eoa: code === "0x",
    };

    if (!result.eoa) {
      result.skip = "wallet has code (EIP-7702 delegate?), risky for _safeMint";
      return result;
    }

    const fnInfo = await probeMintFn(provider, opts.contract, opts.qty, w);
    if (!fnInfo) {
      result.skip = "no mint function passed estimateGas (sold out, paused, or already minted)";
      return result;
    }
    result.fnInfo = fnInfo;
    result.gasLimit = fnInfo.gas + 20000n;

    // budget: maxFee = bal / gasLimit, must cover baseFee + tip
    const tip = 20_000_000n;
    const maxFee = bal / result.gasLimit;
    if (maxFee < result.baseFee + tip) {
      result.skip = `gas budget too low: ${Number(maxFee)/1e9}g < base+tip=${Number(result.baseFee+tip)/1e9}g`;
      result.gasNeeded = (result.baseFee + tip) * result.gasLimit;
      return result;
    }
    result.maxFee = maxFee;
    result.tip = tip;
    return result;
  }));

  // Print preflight summary
  console.log("=".repeat(70));
  console.log("PREFLIGHT");
  console.log("=".repeat(70));
  const ready = [], blocked = [];
  for (const r of preflightResults) {
    if (r.skip) {
      blocked.push(r);
      console.log(`  ✗ ${r.meta.label}  bal=${fmtETH(r.bal)}  SKIP: ${r.skip}`);
    } else {
      ready.push(r);
      const cost = r.gasLimit * r.maxFee;
      console.log(`  ✓ ${r.meta.label}  bal=${fmtETH(r.bal)}  fn=${r.fnInfo.fnName}  cost=${fmtETH(cost)}  maxFee=${(Number(r.maxFee)/1e9).toFixed(3)}g`);
    }
  }
  console.log("=".repeat(70));
  console.log(`Ready: ${ready.length}/${allWallets.length}`);
  
  // Surface gas-needed message for blocked-on-balance wallets
  const needGas = blocked.filter(b => b.gasNeeded);
  if (needGas.length) {
    console.log("\n⚠️  GAS NEEDED (top-up these wallets to mint):");
    for (const b of needGas) {
      const deficit = b.gasNeeded - b.bal;
      const recommend = deficit + (deficit / 5n);  // 20% buffer
      console.log(`    ${b.address}  +${fmtETH(recommend)}  (have ${fmtETH(b.bal)}, need ${fmtETH(b.gasNeeded)})`);
    }
  }

  if (opts.dry) { console.log("\n[dry-run] stop here, no broadcast"); return; }
  if (ready.length === 0) { console.log("\nNo wallets ready, abort"); return; }

  // Phase 2: broadcast in parallel
  console.log("\n" + "=".repeat(70));
  console.log("BROADCAST");
  console.log("=".repeat(70));

  const mintResults = await Promise.all(ready.map(async (r) => {
    const c = new Contract(opts.contract, [r.fnInfo.abi], r.wallet);
    try {
      const tx = await c[r.fnInfo.fnName](...r.fnInfo.args, {
        gasLimit: r.gasLimit,
        maxFeePerGas: r.maxFee,
        maxPriorityFeePerGas: r.tip,
      });
      console.log(`  ${r.meta.label}: tx ${tx.hash}`);
      const receipt = await tx.wait();
      // extract token IDs from Transfer events
      const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
      const tokenIds = receipt.logs
        .filter(l => l.topics[0] === TRANSFER_TOPIC && l.topics[1] === ZERO_TOPIC && l.address.toLowerCase() === opts.contract.toLowerCase())
        .map(l => BigInt(l.topics[3]));
      console.log(`  ${r.meta.label}: ✓ block ${receipt.blockNumber}  gas ${receipt.gasUsed}  status ${receipt.status}  tokens [${tokenIds.join(", ")}]`);
      return { ...r, txHash: tx.hash, receipt, tokenIds };
    } catch (e) {
      console.log(`  ${r.meta.label}: ✗ ${e.shortMessage || e.message}`);
      return { ...r, error: e.shortMessage || e.message };
    }
  }));

  const minted = mintResults.filter(m => m.tokenIds && m.tokenIds.length);
  console.log(`\n[mint] ${minted.length}/${ready.length} successful`);

  // Phase 3: consolidate to wallet-burn (if NFT and consolidate enabled)
  if (!opts.consolidate || minted.length === 0) {
    console.log("\n[consolidate] skipped");
  } else {
    console.log("\n" + "=".repeat(70));
    console.log(`CONSOLIDATE → ${opts.to}`);
    console.log("=".repeat(70));

    // Check destination is EOA (safe for safeTransferFrom)
    const destCode = await provider.getCode(opts.to);
    const useSafe = destCode === "0x";
    const transferAbi = useSafe
      ? "function safeTransferFrom(address from, address to, uint256 tokenId) external"
      : "function transferFrom(address from, address to, uint256 tokenId) external";
    const transferFn = useSafe ? "safeTransferFrom" : "transferFrom";
    console.log(`[consolidate] using ${transferFn} (dest code: ${destCode === "0x" ? "EOA" : destCode.slice(0,10)+"…"})`);

    await Promise.all(minted.flatMap(m => 
      m.tokenIds.map(async (tokenId) => {
        const c = new Contract(opts.contract, [transferAbi], m.wallet);
        const block = await provider.getBlock("latest");
        const bal = await provider.getBalance(m.wallet.address);
        try {
          const gasEst = await c[transferFn].estimateGas(m.wallet.address, opts.to, tokenId);
          const gasLimit = gasEst + 15000n;
          const maxFee = bal / gasLimit;
          if (maxFee < block.baseFeePerGas + 20_000_000n) {
            console.log(`  ${m.meta.label} token ${tokenId}: ✗ insufficient gas to transfer`);
            return;
          }
          const tx = await c[transferFn](m.wallet.address, opts.to, tokenId, {
            gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: 20_000_000n,
          });
          console.log(`  ${m.meta.label} token ${tokenId}: tx ${tx.hash}`);
          const r = await tx.wait();
          console.log(`  ${m.meta.label} token ${tokenId}: ✓ block ${r.blockNumber}`);
        } catch (e) {
          console.log(`  ${m.meta.label} token ${tokenId}: ✗ ${e.shortMessage || e.message}`);
        }
      })
    ));
  }

  // Final tracker entry
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(`chain: ${chainName}  contract: ${opts.contract}`);
  for (const m of mintResults) {
    if (m.tokenIds) console.log(`  ${m.meta.label}: tokens [${m.tokenIds.join(",")}]  tx ${cfg.explorer}${m.txHash}`);
    else if (m.error) console.log(`  ${m.meta.label}: ERROR ${m.error}`);
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
