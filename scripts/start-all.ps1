# 전체 스택을 각각의 PowerShell 창으로 실행한다. (리부팅 후 한 방 기동)
# 사용법:  powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 [-Channels 200] [-NoKill]
#
# 기동 순서: db-api → analysis → router → emulator → viewer/admin
#  - 채널은 DB(SQLite) 명단 기반으로 생성된다. DB 가 비어 있을 때만 -Channels 개 생성 폴백.
#  - 이미 떠 있는 서비스는 먼저 종료한다 (-NoKill 로 생략 가능).
param(
    [int]$Channels = 200,
    [switch]$NoKill
)

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

# ---- 0) 기존 인스턴스 정리 (포트 리스너 기준) ----
if (-not $NoKill) {
    # 7300 라우터 / 7100 분석 / 7500 에뮬레이터 / 7600 db-api / 5173 뷰어 / 5174 어드민
    foreach ($port in 7300, 7100, 7500, 7600, 5173, 5174) {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($conn) {
            try {
                Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false -ErrorAction Stop
                Write-Host "기존 서비스 종료: 포트 $port (pid $($conn.OwningProcess))"
            } catch {}
        }
    }
    Start-Sleep -Seconds 1
}

function Start-Window($title, $workdir, $command) {
    # 주의: $Host 는 자식 셸에서 평가되어야 하므로 백틱으로 이스케이프한다
    $inner = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$workdir'; $command"
    Start-Process powershell -ArgumentList @("-NoExit", "-Command", $inner)
}

# ---- 1) DB API (SQLite, HTTP 7600 / ingest 7601) ----
Start-Window "db-api" (Join-Path $root "db-api") "python main.py"

# ---- 2) 분석 서버 (TCP 7100) ----
Start-Window "analysis-server" (Join-Path $root "analysis-server") "python main.py"

# ---- 3) 라우터 서버 (ingest 7000, http/ws 7300) ----
# 우선순위: 동봉 실행 파일(bin) > 로컬 빌드(target) > cargo 빌드 (Rust 필요)
$routerDir = Join-Path $root "router-server"
$exe = Join-Path $routerDir "bin\router-server.exe"
if (-not (Test-Path $exe)) {
    $exe = Join-Path $routerDir "target\release\router-server.exe"
}
if (-not (Test-Path $exe)) {
    Write-Host "router-server 릴리스 빌드 중... (Rust 필요)"
    Push-Location $routerDir
    & (Join-Path $cargoBin "cargo.exe") build --release
    Pop-Location
    $exe = Join-Path $routerDir "target\release\router-server.exe"
}
Start-Window "router-server" $routerDir $exe

Start-Sleep -Seconds 3

# ---- 4) 입력 에뮬레이터 (DB 명단 기반, 비어 있으면 $Channels 개 생성) ----
Start-Window "emulator" (Join-Path $root "emulator") "python main.py --channels $Channels"

# ---- 5) 뷰어 (http://localhost:5173) / 어드민 (http://localhost:5174) ----
Start-Window "viewer" (Join-Path $root "web\viewer") "npm run dev"
Start-Window "admin" (Join-Path $root "web\admin") "npm run dev"

# ---- 6) 기동 헬스체크 ----
Write-Host ""
Write-Host "기동 확인 중..."
$deadline = (Get-Date).AddSeconds(90)
$health = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod "http://localhost:7300/api/health" -TimeoutSec 2
        if ($health.channel_count -gt 0) { break }
    } catch {}
}
if ($health) {
    Write-Host ("라우터 정상 - 분석 링크 {0} / 채널 {1}개" -f `
        $(if ($health.analysis_connected) { "연결됨" } else { "미연결" }), $health.channel_count)
} else {
    Write-Host "경고: 라우터(:7300) 응답 없음 - router-server 창의 로그를 확인하세요"
}

Write-Host ""
Write-Host "모든 서비스가 시작되었습니다:"
Write-Host "  뷰어    : http://localhost:5173"
Write-Host "  어드민  : http://localhost:5174"
Write-Host "  라우터  : http://localhost:7300/api/health"
Write-Host "  DB API  : http://localhost:7600/health"
Write-Host "  에뮬레이터: http://localhost:7500/status"
