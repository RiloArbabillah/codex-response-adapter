# codex-response-adapter

**Local HTTP adapter** yang menerjemahkan panggilan OpenAI **Responses API** ke protokol native masing-masing provider AI, dan sebaliknya. Dirancang sebagai middleware antara Codex Desktop (atau klien Responses API lainnya) dan berbagai upstream provider.

## Cara Kerja

```
Codex Desktop                          Upstream
    │                                      │
    │  Responses API (POST /v1/responses)  │
    ├────────────────────────────────►      │
    │       codex-response-adapter          │
    │       localhost:8787                  │
    │           │                           │
    │           ├─ Chat-Completions ──────► │   1if, ON Token, b.ai
    │           │   (translasi)             │
    │           │                           │
    │           └─ Responses passthrough ──► │   Z.AI
    │               (langsung)              │
```

Adapter mendukung dua mode wire:

- **Chat-Completions-only** — request Responses API diterjemahkan ke Chat Completions, dikirim ke provider, lalu respon diterjemahkan kembali ke format Responses.
- **Responses-native** — request diferuskan verbatim (passthrough) ke upstream yang sudah mendukung Responses API.

## Routing

Adapter menentukan provider tujuan lewat dua cara:

1. **Bearer token** — setiap API key provider (atau gateway key) dipetakan ke satu provider.
2. **Model slug prefix** — model dengan format `<provider>/<nama-model>` (misalnya `1if/deepseek-v4.1-flash`) dipetakan ke provider berdasarkan prefix-nya. Ini memungkinkan satu gateway key menjangkau semua provider.

## Fitur

| Fitur | Detail |
|---|---|
| Translasi Responses ↔ Chat Completions | Terjemahan tool calls, custom tools, namespace flattening |
| Passthrough Responses-native | Forward verbatim untuk provider yang sudah Responses |
| Health endpoint | `GET /health` — status adapter, provider aktif, concurrency |
| Auto-reload router | `router.json` dipantau dan dimuat ulang otomatis saat berubah |
| Tool call namespace | Namespace MCP/agent diflatkan jadi `<namespace>.<tool>` |
| Custom tools | `apply_patch` dkk diterjemahkan dari `type: custom` ke function tools |
| Gateway key | Satu kredensial klien yang ditukar dengan API key provider |
| EADDRINUSE protection | Deteksi port duplikat, health check, exit graceful |
| Max concurrency & body limits | Batas concurrent requests dan ukuran body |
| Retry otomatis | Retry dengan backoff untuk error transien (429, 5xx) |
| Merged catalog | Gabung model dari beberapa provider jadi satu dropdown |

## Persyaratan

- Node.js 18+ (ESM)
- API key untuk masing-masing provider

## Instalasi

```bash
git clone https://github.com/RiloArbabillah/codex-response-adapter.git
cd codex-response-adapter
```

## Konfigurasi

### 1. Environment Variables

Setiap provider membutuhkan API key yang dibaca dari environment variable. Nama variabelnya didefinisikan di `router.json`:

| Variabel | Provider |
|---|---|
| `ONEIF_API_KEY` | 1if / 1inference |
| `BAI_API_KEY` | b.ai |
| `ONTOKEN_API_KEY` | ON Token |
| `ZAI_API_KEY` | Z.AI |
| `CODEX_ADAPTER_GATEWAY_KEY` | Gateway key klien (opsional) |

Tambahkan ke `~/.zshenv` atau file env lain:

```bash
export ONEIF_API_KEY="sk-..."
export CODEX_ADAPTER_GATEWAY_KEY="gk-..."
```

### 2. router.json

Definisi provider ada di `router.json`. Contoh struktur:

```json
{
  "1if": {
    "upstream": "https://api.1inference.com/v1/chat/completions",
    "envKey": "ONEIF_API_KEY",
    "account": "1if / 1inference",
    "supports": {
      "toolChoice": true,
      "parallelToolCalls": true
    }
  },
  "zai": {
    "upstream": "https://api.z.ai/api/v1/responses",
    "envKey": "ZAI_API_KEY",
    "account": "Z.AI",
    "wire": "responses"
  }
}
```

Field:

| Field | Wajib | Deskripsi |
|---|---|---|
| `upstream` | ✅ | URL endpoint provider |
| `envKey` | ❌ | Nama env var API key (default: `<NAMA>_API_KEY`) |
| `account` | ❌ | Label untuk health endpoint |
| `supports.toolChoice` | ❌ | Provider mendukung `tool_choice` |
| `supports.parallelToolCalls` | ❌ | Provider mendukung parallel tool calls |
| `wire` | ❌ | `"responses"` untuk passthrough, tanpa field ini = Chat Completions |

### 3. Model Catalog (merged catalog)

Untuk menggunakan satu dropdown berisi model dari semua provider:

```bash
# Gabungkan catalog per-provider
node scripts/build-merged-catalog.mjs \
  --out ~/.codex/model-catalogs/merged.json \
  1if=~/.codex/model-catalogs/1if.json \
  ontoken=~/.codex/model-catalogs/ontoken.json \
  bai=~/.codex/model-catalogs/bai.json
```

Konfigurasi Codex Desktop di `~/.codex/config.toml`:

```toml
[model_provider]
wire_api = "responses"
base_url = "http://127.0.0.1:8787/v1/responses"
api_key = "gk-..."   # gateway key
model_catalog_json = "/Users/macbook/.codex/model-catalogs/merged.json"
```

## Menjalankan

### Langsung

```bash
node server.mjs
# listening on http://127.0.0.1:8787 pid=12345 node=v20.x
```

### macOS (launchd)

```bash
./start.sh    # start / restart
./stop.sh     # stop
```

Atau copy `archive/com.codex.responses-adapter.plist` ke `~/Library/LaunchAgents/` dan load.

## API Endpoint

### `POST /v1/responses`

Menerima body OpenAI Responses API (dengan `input` bukan `messages`). Lihat dokumentasi OpenAI Responses API untuk format lengkap.

### `GET /health`

```json
{
  "ok": true,
  "pid": 12345,
  "uptimeMs": 3600000,
  "activeRequests": 0,
  "maxConcurrency": 8,
  "providers": [
    { "name": "1if", "upstream": "https://api.1inference.com/v1/chat/completions", "account": "1if / 1inference" }
  ],
  "gatewayKeys": 1
}
```

## Verifikasi

```bash
# Cek health
curl -s http://127.0.0.1:8787/health | python3 -m json.tool

# Test request sederhana
curl -s http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $ONEIF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "input": "Halo, balas dengan singkat."
  }' | python3 -m json.tool
```

## Menambah Provider Baru

**Chat-Completions-only:**
1. Tambah entri di `router.json` (`upstream`, `envKey`, `account`, `supports`).
2. Generate catalog dari `/v1/models` provider.
3. Masukkan ke merged catalog via `scripts/build-merged-catalog.mjs`.

**Responses-native:**
1. Tambah entri di `router.json` dengan `"wire": "responses"`.
2. Generate catalog via `scripts/build-responses-catalog.mjs`.
3. Masukkan ke merged catalog.
4. Restart adapter.

## Struktur Direktori

```
├── server.mjs                          # Main adapter
├── router.json                         # Definisi provider
├── run.sh                              # Entrypoint launchd (dengan log rotation)
├── start.sh                            # Start / restart via launchd
├── stop.sh                             # Stop via launchd
├── scripts/
│   ├── build-merged-catalog.mjs        # Gabung catalog per-provider
│   └── build-responses-catalog.mjs     # Generate catalog dari /v1/models
└── archive/
    └── com.codex.responses-adapter.plist  # Contoh konfigurasi launchd
```
