#!/usr/bin/env bash
set -Eeuo pipefail

# Asumsi: setup satu kali dan migrasi sesuai panduan README.md sudah selesai.
# Launcher ini tidak menjalankan migrasi atau seed.

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  printf '%s\n' 'ERROR: File .env tidak ditemukan di root proyek. Ikuti panduan setup di README.md terlebih dahulu.' >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'ERROR: Docker tidak ditemukan. Instal Docker Engine/Desktop dan pastikan perintah docker tersedia di PATH.' >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'ERROR: Docker Compose v2 tidak tersedia. Pastikan perintah docker compose dapat dijalankan.' >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf '%s\n' 'ERROR: pnpm tidak ditemukan. Instal atau aktifkan pnpm, lalu pastikan tersedia di PATH.' >&2
  exit 1
fi

printf '%s\n' 'Menyiapkan PostgreSQL dan penyimpanan foto lokal...'
if ! pnpm db:start; then
  printf '%s\n' 'ERROR: Database atau penyimpanan lokal gagal disiapkan. Pastikan Docker berjalan dan periksa pesan Compose di atas.' >&2
  exit 1
fi

printf '%s\n' 'Menjalankan API dan web. Tekan Ctrl+C untuk menghentikan proses dev.'
exec pnpm dev:all
