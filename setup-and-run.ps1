# =====================================================================
# ECG 소켓 채널 라우터 — 원클릭 설치 + 실행 스크립트 (Windows)
#
# 처음 받은 컴퓨터에서 이 파일 하나로 준비부터 기동까지 끝냅니다:
#   1) 필수 프로그램 확인  : Python 3.10+, Node.js 18+ (없으면 설치 안내)
#   2) 프런트엔드 패키지    : web/viewer, web/admin 에 npm install (최초 1회)
#   3) 6개 서비스 순차 실행 : DB API → 분석 서버 → 라우터 → 에뮬레이터 → 뷰어 → 어드민
#      (라우터는 동봉된 router-server\bin\router-server.exe 사용 — Rust 설치 불필요)
#
# 사용법 (프로젝트 루트에서):
#   powershell -ExecutionPolicy Bypass -File setup-and-run.ps1
#   powershell -ExecutionPolicy Bypass -File setup-and-run.ps1 -Channels 500
#
# 기동 후: 어드민 http://localhost:5174 → 테스트 > DB 리셋 을 한 번 실행하면
#          병원별 DB(각 200채널 + 재고 + 기본 그룹 10개)가 만들어집니다.
# =====================================================================
param(
    [int]$Channels = 200
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Fail($msg) {
    Write-Host ""
    Write-Host "[중단] $msg" -ForegroundColor Red
    exit 1
}

Write-Host "=== 1/3 필수 프로그램 확인 ===" -ForegroundColor Cyan

# Python 3.10+
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
    Fail "Python 이 없습니다. https://www.python.org/downloads/ 에서 3.10 이상 설치 후 다시 실행하세요. (winget install Python.Python.3.12)"
}
$pyVer = (& python -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')")
if ([version]$pyVer -lt [version]"3.10") {
    Fail "Python $pyVer 감지 — 3.10 이상이 필요합니다."
}
Write-Host "  Python $pyVer  OK"

# Node.js 18+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Node.js 가 없습니다. https://nodejs.org 에서 18 이상(LTS) 설치 후 다시 실행하세요. (winget install OpenJS.NodeJS.LTS)"
}
$nodeVer = (& node --version).TrimStart('v')
if ([version]$nodeVer -lt [version]"18.0") {
    Fail "Node.js $nodeVer 감지 — 18 이상이 필요합니다."
}
Write-Host "  Node.js $nodeVer  OK"

# 라우터 실행 파일 (동봉본 우선 — 없으면 Rust 빌드 필요)
$routerExe = Join-Path $root "router-server\bin\router-server.exe"
if (Test-Path $routerExe) {
    Write-Host "  router-server.exe (동봉 실행 파일)  OK"
} elseif (Test-Path (Join-Path $root "router-server\target\release\router-server.exe")) {
    Write-Host "  router-server.exe (로컬 빌드)  OK"
} elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "  동봉 실행 파일 없음 -> Rust(cargo)로 빌드합니다 (수 분 소요)"
} else {
    Fail "router-server 실행 파일이 없고 Rust 도 없습니다. router-server\bin\router-server.exe 가 포함된 패키지인지 확인하세요."
}

Write-Host ""
Write-Host "=== 2/3 프런트엔드 패키지 설치 (최초 1회) ===" -ForegroundColor Cyan
foreach ($app in @("web\viewer", "web\admin")) {
    $dir = Join-Path $root $app
    if (Test-Path (Join-Path $dir "node_modules")) {
        Write-Host "  $app : node_modules 존재 — 건너뜀"
    } else {
        Write-Host "  $app : npm install 실행 중..."
        Push-Location $dir
        npm install --no-fund --no-audit | Out-Null
        if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "$app npm install 실패" }
        Pop-Location
        Write-Host "  $app : 설치 완료"
    }
}

Write-Host ""
Write-Host "=== 3/3 서비스 6개 순차 실행 ===" -ForegroundColor Cyan
& powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\start-all.ps1") -Channels $Channels

Write-Host ""
Write-Host "완료! 어드민(http://localhost:5174)에서 [테스트 > DB 리셋]을 한 번 실행하세요." -ForegroundColor Green
