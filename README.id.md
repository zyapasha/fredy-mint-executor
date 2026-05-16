# fredy-mint-executor

🌐 [English](README.md) · **Bahasa Indonesia**

> Mint NFT secara paralel dari beberapa wallet EVM sekaligus dalam satu perintah. Auto-deteksi chain, probe fungsi mint, hitung gas budget, broadcast, lalu konsolidasi NFT ke wallet tujuan.

Repo ini bagian dari [FREDY](https://github.com/zyapasha/fredy-mint-executor#tentang-fredy), agen Web3 + dev-ops otonom yang jalan di atas framework [Hermes Agent](https://hermes-agent.nousresearch.com). Pipeline mint-nya gw pisah jadi CLI standalone supaya bisa dipakai siapa aja.

## Untuk pemula: ini buat apa sih?

Bayangin lo punya 5 wallet kosong yang tiap-tiap wallet eligible mint 1 NFT free. Cara manual:

1. Buka MetaMask, switch wallet ke wallet #1
2. Buka website mint, click "Mint", approve di MetaMask
3. Tunggu konfirmasi
4. Switch wallet ke #2, ulangi
5. ...begitu seterusnya 5 kali
6. Total ~5-10 menit, dan kalau supply terbatas, bisa keburu sold out

Dengan tool ini:

```bash
node mint.js 0xCONTRACT
```

Selesai dalam ~10 detik. Semua wallet mint paralel, NFT otomatis dipindah ke cold wallet lo.

**Siapa yang butuh ini?**
- Kolektor NFT yang ikut FCFS (first-come-first-served) mint
- Anyone yang punya beberapa wallet airdrop dan males switch manual
- User yang udah sering ke-rugian karena sold out di pertengahan klik

**Yang HARUS lo punya sebelum mulai:**
- Linux / macOS / WSL (Windows Subsystem for Linux)
- Node.js 20 atau lebih baru — cek dengan `node --version`
- GnuPG — cek dengan `gpg --version`
- Wallet EVM (mnemonic 12 kata atau private key) yang isinya cukup buat gas
- Address contract NFT yang mau di-mint

## Apa yang dilakukan tool ini

Lo kasih address contract NFT. Tool akan:

1. **Deteksi chain otomatis** — Ethereum, Base, Arbitrum, Optimism (lewat `eth_getCode`)
2. **Load wallet dari encrypted secret store** (GPG AES256, plaintext gak pernah disimpan)
3. **Preflight tiap wallet paralel:**
   - Cek saldo + verifikasi EOA (no EIP-7702 delegate)
   - Probe fungsi mint: coba `mint(uint256)`, `publicMint(uint256)`, `claim(uint256)`, `mint()` lewat `estimateGas`
   - Hitung gas budget: `maxFeePerGas = saldo / gasLimit`
4. **Surface blocker dalam satu pesan** — misal "wallet X butuh top-up +0.0001 ETH"
5. **Broadcast paralel** — semua wallet siap fire tx-nya bareng
6. **Konsolidasi NFT** ke wallet tujuan (default: cold wallet) lewat `safeTransferFrom`

End-to-end ~10 detik dari invoke sampai broadcast untuk 5 wallet.

## Kenapa pakai tool ini

Buat FCFS mint, bottleneck-nya bukan compute — tapi manusia. Tool yang nyuruh lo:
- copy contract address ke UI
- klik "estimate gas"
- cek saldo cukup gak
- tunggu, switch wallet, ulangi
- transfer NFT ke cold wallet manual

…kalah sama bot yang 200ms udah selesai semua. Ini versi bot-nya, tapi transparent + open source.

Tool ini juga handle failure mode yang sering kena pemula:

- **Free mint tapi `getFeeData()` return `maxFeePerGas` lebih tinggi dari saldo** → script override jadi `saldo/gasLimit`. Tx tetap mine di `effectiveGasPrice = baseFee + tip`, sisa di-refund.
- **Wallet kena EIP-7702 delegate** → auto skip dari contract `_safeMint` (kalau gak akan revert `ERC721InvalidReceiver`).
- **Wallet udah pernah mint** → `estimateGas` revert, wallet auto-skip.
- **RPC kena rate limit** → coba 4 chain paralel, ambil yang pertama balas dengan code.

## Install

```bash
git clone https://github.com/zyapasha/fredy-mint-executor.git
cd fredy-mint-executor
npm install
```

Butuh Node.js 20+ dan GnuPG.

## Setup secret store (sekali aja)

Bagian paling penting — wallet lo disimpan terenkripsi, bukan di file plain text. Step-by-step:

```bash
# 1. Bikin folder config
mkdir -p ~/.config/mint-executor

# 2. Tulis daftar wallet ke file sementara
#    Format: <label>-<field>=<value>
#    Field: address, mnemonic, pk, derivation
cat > /tmp/wallets.txt << 'EOF'
airdrop-01-address=0xAlamatEvmKamu
airdrop-01-mnemonic=kata1 kata2 kata3 ... kata12
airdrop-01-derivation=m/44'/60'/0'/0/0
EOF

# 3. Generate passphrase random buat encryption
openssl rand -base64 32 | tr -d '\n' > ~/.config/mint-executor/.key
chmod 400 ~/.config/mint-executor/.key

# 4. Encrypt + hapus plaintext (penting!)
gpg --batch --yes --passphrase-file ~/.config/mint-executor/.key --pinentry-mode loopback \
    --symmetric --cipher-algo AES256 \
    --output ~/.config/mint-executor/wallets.gpg /tmp/wallets.txt
shred -u /tmp/wallets.txt
chmod 600 ~/.config/mint-executor/wallets.gpg
```

Script akan baca `wallets.gpg` cuma di memory. Setelah step 4, plaintext gak ada lagi di disk.

⚠️ **Backup `~/.config/mint-executor/.key` di tempat aman (offline drive / password manager).** Tanpa file ini, wallet.gpg gak bisa di-decrypt — secret lo permanen hilang.

## Cara pakai

```bash
# Full auto: deteksi chain, probe fn, mint dengan semua wallet, konsolidasi
node mint.js 0xCONTRACT

# Cuma preflight, gak broadcast (recommended buat first time!)
node mint.js 0xCONTRACT --dry

# Mint 2 NFT per wallet
node mint.js 0xCONTRACT --qty=2

# Force chain tertentu (skip auto-detect, lebih cepat)
node mint.js 0xCONTRACT --chain=base

# Force nama fungsi mint
node mint.js 0xCONTRACT --fn=publicMint

# Filter wallet by suffix label
node mint.js 0xCONTRACT --wallets=01,02

# Skip konsolidasi (NFT tetap di wallet minting)
node mint.js 0xCONTRACT --no-consolidate

# Kirim NFT ke wallet tujuan custom
node mint.js 0xCONTRACT --to=0xColdWalletKamu
```

**Tips pemula:** selalu run dengan `--dry` dulu di first run. Cek output preflight, kalau aman baru run ulang tanpa `--dry`.

## Contoh output

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

## Konfigurasi (opsional)

File `~/.config/mint-executor/config.json`:

```json
{
  "secretFile": "~/.config/mint-executor/wallets.gpg",
  "passphraseFile": "~/.config/mint-executor/.key",
  "defaultConsolidationTarget": "0xColdWalletKamu",
  "chains": {
    "ethereum": "https://your.preferred.rpc",
    "base":     "https://mainnet.base.org",
    "arbitrum": "https://arb1.arbitrum.io/rpc",
    "optimism": "https://mainnet.optimism.io"
  }
}
```

## Catatan keamanan

- **JANGAN PERNAH commit** `wallets.gpg`, `.key`, atau file mnemonic plaintext. `.gitignore` udah handle lokasi standar.
- Script gak pernah log PK / mnemonic ke stdout. Cuma address, tx hash, dan saldo yang muncul di output.
- Chain pre-EIP-7702 (sebelum Pectra) gak terdampak EOA check; script cuma baca panjang code.
- Wallet tujuan konsolidasi di-cek dulu apakah ada code (smart contract) — kalau ada, pakai `transferFrom` (bukan `safeTransferFrom`). Kalau cold wallet lo Safe / Argent / Gnosis multisig, behavior ini sengaja.

Failure mode yang dihindari: free-mint script yang hardcode `getFeeData()` akan revert "insufficient funds for intrinsic transaction cost" di saldo tipis, padahal mint sebenarnya cuma butuh setengah budget. Fix: compute `maxFeePerGas = saldo / gasLimit` jadi budget gak pernah lebih dari yang ada. Protokol EIP-1559 refund kelebihan di `effectiveGasPrice`.

## Tentang FREDY

Script ini satu bagian dari stack agen otonom:

- **Telethon listener** monitor source alpha Web3, classify lead, forward ke private channel
- **9router** — multi-LLM router (Claude, GPT, MiMo) priority fallback + quota-aware backoff
- **Hermes Agent** — layer orkestrasi dengan persistent memory, 100+ skill, EIP-7702 / Sourcify preflight
- **mint-executor** (repo ini) — broadcast pipeline

Production usage 7-hari per pertengahan Mei 2026: ~6,000 request LLM, 90M input token, 3 mint NFT sukses di Ethereum mainnet.

## Lisensi

MIT — lihat [LICENSE](LICENSE).

## Kontribusi

PR welcome buat:

- Chain tambahan (zkSync, Linea, Scroll, Polygon zkEVM, Blast)
- Pattern fungsi mint (signature-gated, merkle proof, mintWithReferral)
- Support hardware wallet (Ledger via `@ledgerhq/hw-app-eth`)
- Counterpart Solana (Metaplex Candy Machine V3)

## Disclaimer

Risiko ditanggung sendiri. Mint NFT + broadcast transaksi pakai uang beneran. Script ini gak audit code contract di luar function probing — buat paid mint, audit dulu (Sourcify verification, review source buat footgun) sebelum point script ke contract. Author gak bertanggung jawab atas dana hilang akibat malicious contract, MEV, atau salah konfig dari sisi user.
