# Asumsi: setup satu kali dan migrasi sesuai panduan README.md sudah selesai.
# Launcher ini tidak menjalankan migrasi atau seed.

$repoRoot = $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$envFile = Join-Path $repoRoot '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    [Console]::Error.WriteLine('ERROR: File .env tidak ditemukan di root proyek. Ikuti panduan setup di README.md terlebih dahulu.')
    exit 1
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('ERROR: Docker tidak ditemukan. Instal Docker Desktop dan pastikan perintah docker tersedia di PATH.')
    exit 1
}

$null = & docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('ERROR: Docker Compose v2 tidak tersedia. Pastikan perintah docker compose dapat dijalankan.')
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('ERROR: pnpm tidak ditemukan. Instal atau aktifkan pnpm, lalu pastikan tersedia di PATH.')
    exit 1
}

Write-Host 'Menyiapkan PostgreSQL dan penyimpanan foto lokal...' -ForegroundColor Cyan
& pnpm db:start
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('ERROR: Database atau penyimpanan lokal gagal disiapkan. Pastikan Docker berjalan dan periksa pesan Compose di atas.')
    exit $LASTEXITCODE
}

Write-Host 'Menjalankan API dan web. Tekan Ctrl+C untuk menghentikan proses dev.' -ForegroundColor Cyan
& pnpm dev:all
$devExitCode = $LASTEXITCODE
if ($devExitCode -ne 0) {
    [Console]::Error.WriteLine("ERROR: Proses pnpm dev:all berhenti dengan kode $devExitCode.")
    exit $devExitCode
}
