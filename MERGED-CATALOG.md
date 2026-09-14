# Merged multi-provider catalog

Kodex Desktop hanya membaca **satu** config efektif: `model_provider` +
`model_catalog_json` dari `~/.codex/config.toml`. Fitur ini menggabungkan model
dari beberapa akun jadi satu dropdown, dengan adapter lokal
(`127.0.0.1:8787`) yang merutekan tiap request ke upstream yang benar.

## Cara kerja

1. `~/.codex/config.toml` memakai provider `merged` → adapter di port 8787.
2. Katalog `merged.json` berisi semua model dengan slug ber-prefix
   `<provider>/<model>` (contoh: `ontoken/glm-5.3-flash`).
3. Adapter membaca prefix slug:
   - `ontoken/...`, `1if/...`, `bai/...` → diterjemahkan Responses ⇄ Chat
     Completions lalu diteruskan ke upstream masing-masing.
   - `zai/...` → **passthrough** langsung (upstream sudah Responses-native).
   - Tanpa prefix → pakai provider dari bearer token (perilaku lama).
4. Kredensial klien pakai satu key: `CODEX_ADAPTER_GATEWAY_KEY` (di `~/.zshenv`).
   Adapter menukar key ini dengan API key provider yang sesuai sebelum request
   diteruskan. Key gateway **tidak pernah** dikirim ke upstream.

## Menambah provider baru

Provider Chat-Completions-only:

1. Tambahkan entri di `router.json` (`upstream`, `envKey`, `account`, `supports`).
2. Buat catalog `~/.codex/model-catalogs/<name>.json` (dari `/v1/models`).
3. Masukkan ke `merged.json` lewat `scripts/build-merged-catalog.mjs`.

Provider Responses-native:

1. Tambahkan entri di `router.json` dengan `"wire": "responses"` dan `upstream`
   langsung ke endpoint `/responses`.
2. Buat catalog dengan `scripts/build-responses-catalog.mjs`.
3. Masukkan ke `merged.json`.

## Refresh katalog

```bash
cd /path/to/codex-response-adapter

# Chat-Completions providers: regenerate masing-masing dari /v1/models dulu,
# lalu gabungkan.
node scripts/build-merged-catalog.mjs \
  --out /Users/macbook/.codex/model-catalogs/merged.json \
  1if=/Users/macbook/.codex/model-catalogs/1if.json \
  ontoken=/Users/macbook/.codex/model-catalogs/ontoken.json \
  bai=/Users/macbook/.codex/model-catalogs/bai.json

# Restart adapter supaya router.json baru terbaca (katalog cukup refocus app).
./start.sh
```

## Verifikasi

```bash
curl -s http://127.0.0.1:8787/health | python3 -m json.tool   # cek providers + gatewayKeys
codex debug models | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["models"]))'
```

## Batasan

- Slug upstream yang mengandung `/` pada provider Chat-Completions tetap aman
  (anti bentrok prefix) karena adapter hanya memecah prefix yang namanya
  terdaftar di `router.json`.
- Model yang sama di dua provider muncul dua kali (`1if/...` dan `ontoken/...`).
  Itu memang disengaja supaya bisa memilih upstream.
- Setelah ubah `router.json`/provider, restart adapter. Setelah ubah katalog,
  cukup refocus window Desktop (cache 5 menit).
