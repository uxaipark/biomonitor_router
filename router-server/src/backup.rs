//! 생체신호(파형) 백업: 닫힌 시간 파일을 NAS(마운트 경로) / SMB / FTP / FTPS / SFTP 대상으로 복사하고, 복사본을 다시
//! 읽어 검증한 뒤에만 저장소가 로컬 파일을 지우도록 한다.
//!
//! * 대상 카드 순서 = 우선순위. `copies`(필요 사본 수)만큼 성공할 때까지 위에서부터 시도하고, 실패한 대상은 잠시
//!   건너뛰어(지수 백오프) 다음 순위로 넘어간다 → copies=1 이면 장애 조치, copies≥2 면 중복 백업.
//! * 검증: 기본은 원격 파일을 다시 받아 SHA-256 비교(`sha256`), 빠른 모드는 크기 비교(`size`).
//! * 삭제: 기본(`cap`)은 저장 상한에 닿았을 때 백업 완료 파일만 오래된 순으로 지움(백업 안 된 파일은 보존).
//!   `immediate` 는 검증 직후 로컬 삭제. 디스크 여유가 `emergency_free_pct` 아래로 떨어지면 백업 안 된 파일도 지우고
//!   사건으로 기록한다(수신 중단보다 오래된 파형 유실이 낫다).
//! * 원격 배치는 로컬과 같다: `<경로>/patches/<패치 8자리>/<YYYYMMDD-HH>.rec`. 로컬에서 지운 뒤 같은 이름의 파일이 다시
//!   생기면(MCOT 게이트웨이의 저장 후 전송 재생) 덮어쓰지 않도록 `<시간>.late-<ms>.rec` 로 올린다.
//! * 전송: FTP/FTPS/SFTP 는 `curl`(자격 증명은 `-K -` 로 표준 입력 전달 — ps 에 안 보임), SMB 는 `smbclient`.

use crate::state::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};
use tracing::{info, warn};

pub const KINDS: &[&str] = &["nas", "smb", "ftp", "ftps", "sftp"];

/// 활성 대상이 하나라도 있으면 true: 저장소는 백업 완료(SAFE) 파일만 지운다.
pub static ACTIVE: AtomicBool = AtomicBool::new(false);
/// 필요 사본 수만큼 검증된 파일: 상대 경로 → 백업 당시 크기(크기가 바뀌면 다시 백업).
pub static SAFE: LazyLock<dashmap::DashMap<String, u64>> = LazyLock::new(dashmap::DashMap::new);
pub static EMERGENCY_FREE_PCT: AtomicU64 = AtomicU64::new(5);
/// 저장소가 지운 파일(상대 경로) — 백업 스레드가 장부에서 지우고 묘비를 남긴다.
/// FTP/FTPS/SFTP: 설정된 원격 디렉터리에 들어가 본 시각 (대상 id + 경로 → ms). 10분 동안은 다시 확인하지 않는다.
static BASE_OK: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 전송 중인 curl/smbclient 프로세스 — '백업 중단'이 바로 끊는다
static CHILDREN: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
/// '백업 중단' 횟수. 작업 중에 바뀌면 그 작업의 실패는 대상 장애로 세지 않는다.
static ABORT_GEN: AtomicU64 = AtomicU64::new(0);

fn spawn_tracked(cmd: &mut Command) -> Result<std::process::Child, String> {
    let child = cmd.spawn().map_err(|e| format!("실행 실패: {e}"))?;
    CHILDREN.lock().unwrap().insert(child.id());
    Ok(child)
}
fn wait_tracked(child: std::process::Child) -> Result<std::process::Output, String> {
    let pid = child.id();
    let r = child.wait_with_output().map_err(|e| format!("대기 실패: {e}"));
    CHILDREN.lock().unwrap().remove(&pid);
    r
}

/// 원격 목록 읽기 진행 상태 (대상 id → JSON)
static SYNC: LazyLock<Mutex<HashMap<String, serde_json::Value>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `patches/00076509/20260923-07.rec` → `20260923-07`
fn hour_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.strip_suffix(".rec.gz").or_else(|| name.strip_suffix(".rec")).unwrap_or(name).to_string()
}

/// FTP/SFTP LIST 한 줄(`-rw-r--r-- 1 u g 3582000 Sep 24 19:45 name`) → (이름, 크기, 디렉터리?)
fn parse_list_line(l: &str) -> Option<(String, Option<u64>, bool)> {
    let tok: Vec<&str> = l.split_whitespace().collect();
    if tok.len() >= 9 && (tok[0].starts_with('-') || tok[0].starts_with('d') || tok[0].starts_with('l')) {
        let name = tok[8..].join(" ");
        if name == "." || name == ".." {
            return None;
        }
        return Some((name, tok[4].parse().ok(), tok[0].starts_with('d')));
    }
    None
}

pub static FORGET_Q: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
/// 상한을 넘었지만 백업이 안 돼 지우지 못한 바이트 (마지막 prune 기준)
pub static BLOCKED_BYTES: AtomicU64 = AtomicU64::new(0);
/// 디스크 여유 부족으로 백업 없이 지운 파일/바이트 누적
pub static UNBACKED_DELETED: AtomicU64 = AtomicU64::new(0);
pub static UNBACKED_DELETED_BYTES: AtomicU64 = AtomicU64::new(0);

/// 저장소 prune 이 이 파일을 지워도 되는가
pub fn may_delete(rel: &str, size: u64) -> bool {
    !ACTIVE.load(Ordering::Relaxed) || SAFE.get(rel).map(|s| *s == size).unwrap_or(false)
}

/// 저장소 전체 삭제: 장부의 모든 파일을 지운 것으로 처리 (원격 사본은 남고, 같은 이름이 다시 생기면 .late 로 올라간다)
pub static RESET_REQ: AtomicBool = AtomicBool::new(false);
pub fn on_store_reset() {
    SAFE.clear();
    RESET_REQ.store(true, Ordering::Relaxed);
}

/// 저장소가 파일을 지웠다
pub fn forgotten(rel: String) {
    SAFE.remove(&rel);
    if let Ok(mut q) = FORGET_Q.lock() {
        q.push(rel);
    }
}

/// 저장소 루트가 있는 볼륨의 (전체, 여유) 바이트
pub fn volume_stats(path: &Path) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let mut p = path.as_os_str().as_bytes().to_vec();
        p.push(0);
        unsafe {
            let mut st: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(p.as_ptr() as *const libc::c_char, &mut st) == 0 {
                let fr = st.f_frsize as u64;
                return ((st.f_blocks as u64) * fr, (st.f_bavail as u64) * fr);
            }
        }
        (0, 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        crate::sysmon::disk_stats()
    }
}

fn yes() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct Target {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// SMB 공유 이름
    #[serde(default)]
    pub share: String,
    /// 원격 기준 경로 (NAS 는 마운트된 로컬 경로)
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub domain: String,
    /// SFTP 개인 키 경로 (비우면 비밀번호)
    #[serde(default)]
    pub key_path: String,
    /// FTPS/SFTP: 인증서·호스트 키 검사 생략. NAS: 마운트 확인 생략(로컬 디스크 허용).
    #[serde(default)]
    pub insecure: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

/// API 입력: 비밀번호는 `password` 가 있을 때만 바꾸고(`clear_password` 로 지움), 출력에는 절대 싣지 않는다.
#[derive(Deserialize)]
pub struct TargetInput {
    #[serde(flatten)]
    pub t: Target,
    #[serde(default)]
    pub clear_password: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Policy {
    /// 로컬 삭제 전에 필요한 검증된 사본 수 (1 = 장애 조치, 2 이상 = 중복 백업)
    #[serde(default = "d_copies")]
    pub copies: u32,
    /// `cap` = 저장 상한 도달 시 백업 완료 파일부터 삭제, `immediate` = 검증 직후 삭제
    #[serde(default = "d_delete")]
    pub delete_mode: String,
    /// `sha256` = 원격을 다시 읽어 해시 비교, `size` = 크기만 비교
    #[serde(default = "d_verify")]
    pub verify: String,
    /// 시간 파일이 끝난 뒤(그리고 마지막 쓰기 뒤) 이만큼 지나야 백업 (늦게 도착하는 레코드 대비)
    #[serde(default = "d_min_age")]
    pub min_age_min: u32,
    /// 디스크 여유가 이 비율 아래면 백업 안 된 파일도 오래된 것부터 삭제
    #[serde(default = "d_emergency")]
    pub emergency_free_pct: u32,
    /// 동시에 처리하는 파일 수 (1–8)
    #[serde(default = "d_parallel")]
    pub parallel: u32,
    /// 대상별 전송 속도 제한 KB/s (0 = 제한 없음, curl 대상만)
    #[serde(default)]
    pub rate_limit_kbps: u32,
    /// 파일 1개 전송·검증 제한 시간(초)
    #[serde(default = "d_timeout")]
    pub timeout_s: u32,
    /// 전송 일시 중지 (삭제 보호는 그대로)
    #[serde(default)]
    pub paused: bool,
    /// 파형 파일 저장 단위(시간): 패치마다 이 시간 단위로 파일 하나 (1·2·3·4·6·8·12·24). 바꾸면 다음 기록부터.
    #[serde(default = "d_block_hours")]
    pub block_hours: u32,
}
fn d_block_hours() -> u32 {
    2
}
fn d_copies() -> u32 {
    1
}
fn d_delete() -> String {
    "cap".into()
}
fn d_verify() -> String {
    "sha256".into()
}
fn d_min_age() -> u32 {
    10
}
fn d_emergency() -> u32 {
    5
}
fn d_parallel() -> u32 {
    2
}
fn d_timeout() -> u32 {
    600
}
impl Default for Policy {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

#[derive(Default, Clone, Serialize)]
struct TargetStat {
    ok_files: u64,
    ok_bytes: u64,
    fail: u64,
    last_ok_ms: u64,
    last_err: String,
    last_err_ms: u64,
    fail_streak: u32,
    busy: u32,
    avg_ms: u64,
    #[serde(skip)]
    down_until: Option<Instant>,
    down_s: u64,
}

#[derive(Clone, Serialize)]
struct LogEntry {
    ts_ms: u64,
    target: String,
    rel: String,
    bytes: u64,
    ms: u64,
    ok: bool,
    msg: String,
}

#[derive(Clone)]
struct Copy {
    target: String,
    size: u64,
    sha: [u8; 32],
}

struct Job {
    rel: String,
    size: u64,
}

#[derive(Default, Clone, Serialize)]
struct Pending {
    files: u64,
    bytes: u64,
    oldest: String,
    safe_files: u64,
    safe_bytes: u64,
    local_files: u64,
    local_bytes: u64,
    /// 닫혔지만 아직 무결성 확인(봉인 `.sum`)이 안 끝난 파일 — 봉인 뒤에 백업한다
    unsealed_files: u64,
    /// 봉인 때 항목 CRC 오류가 나온 파일 (그래도 백업은 한다: 성한 항목까지 잃지 않도록)
    bad_sealed_files: u64,
}

pub struct Backup {
    root: PathBuf,
    work: PathBuf,
    db: Mutex<Connection>,
    policy: RwLock<Policy>,
    targets: RwLock<Vec<Target>>,
    stats: Mutex<HashMap<String, TargetStat>>,
    log: Mutex<VecDeque<LogEntry>>,
    queue: Mutex<VecDeque<Job>>,
    cv: Condvar,
    inflight: Mutex<HashSet<String>>,
    ledger: Mutex<HashMap<String, Vec<Copy>>>,
    tombs: Mutex<HashMap<String, u64>>,
    smb_dirs: Mutex<HashSet<(String, String)>>,
    pending: Mutex<Pending>,
    last_scan_ms: AtomicU64,
    scan_now: AtomicBool,
    unbacked_seen: AtomicU64,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS backup_targets (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backup_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backup_files (rel TEXT NOT NULL, target TEXT NOT NULL, size INTEGER NOT NULL, sha BLOB NOT NULL,
  remote TEXT NOT NULL, done_ms INTEGER NOT NULL, PRIMARY KEY (rel, target));
CREATE TABLE IF NOT EXISTS backup_tombs (rel TEXT PRIMARY KEY, deleted_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backup_daily (day TEXT NOT NULL, target TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (day, target));
-- 대상별 백업 목록: 로컬 파일을 지워도 남는다 (backup_files 는 로컬에 있는 파일의 사본 기록이라 지우면 같이 빠진다).
-- src: upload = 라우터가 올리고 검증함, remote = 원격 목록 읽기로 찾음(크기만 확인)
CREATE TABLE IF NOT EXISTS backup_catalog (target TEXT NOT NULL, rel TEXT NOT NULL, hour TEXT NOT NULL, size INTEGER NOT NULL, sha BLOB,
  done_ms INTEGER NOT NULL, src TEXT NOT NULL DEFAULT 'upload', PRIMARY KEY (target, rel));
CREATE INDEX IF NOT EXISTS backup_catalog_th ON backup_catalog (target, hour);
CREATE INDEX IF NOT EXISTS backup_catalog_rel ON backup_catalog (rel);
";

fn now_ms() -> u64 {
    crate::protocol::now_ms()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn day_key(ms: u64) -> String {
    // UTC 날짜 (시간 파일 이름과 같은 기준)
    crate::patch_store::hour_key(ms)[..8].to_string()
}

/// 파일 키(`YYYYMMDD-HH_<N>h`, 옛 `YYYYMMDD-HH`) → 그 블록이 끝나는 UTC ms
fn hour_end_ms(key: &str) -> Option<u64> {
    crate::patch_store::key_range(key).map(|r| r.1)
}

/// 봉인에 적힌 SHA-256 (hex) → bytes
fn seal_sha(seal: &crate::patch_store::Seal) -> Option<[u8; 32]> {
    let h = seal.sha256.as_bytes();
    if h.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(std::str::from_utf8(&h[i * 2..i * 2 + 2]).ok()?, 16).ok()?;
    }
    Some(out)
}

fn sha_file(path: &Path) -> std::io::Result<([u8; 32], u64)> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((h.finalize().into(), n))
}

fn sha_reader(mut r: impl Read) -> std::io::Result<([u8; 32], u64)> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut n = 0u64;
    loop {
        let k = r.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((h.finalize().into(), n))
}

/// URL 경로 인코딩 ('/' 와 '~' 는 그대로)
fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

fn join_remote(base: &str, rel: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        rel.to_string()
    } else {
        format!("{b}/{rel}")
    }
}

/// curl -K 설정 값 인용
fn kq(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn run_with_stdin(mut cmd: Command, stdin: &str) -> Result<std::process::Output, String> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn_tracked(&mut cmd)?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(stdin.as_bytes());
    }
    wait_tracked(child)
}

/// curl / smbclient 종료 코드 → 원인 안내
fn hint(o: &std::process::Output) -> &'static str {
    let err = String::from_utf8_lossy(&o.stderr);
    if o.status.code() == Some(127) || err.contains("failed to run command") {
        return " — smbclient 가 설치되어 있지 않습니다 (sudo apt install smbclient)";
    }
    if err.contains("NT_STATUS_LOGON_FAILURE") || err.contains("NT_STATUS_ACCESS_DENIED") {
        return " — 사용자·비밀번호 또는 공유 권한을 확인하세요";
    }
    if err.contains("NT_STATUS_BAD_NETWORK_NAME") {
        return " — 공유 이름이 없습니다";
    }
    if err.contains("smbclient") || err.contains("NT_STATUS") {
        return "";
    }
    match o.status.code() {
        Some(2) => " — 초기화 실패: SFTP 는 대부분 호스트 키가 ~/.ssh/known_hosts 에 없을 때입니다 ('호스트 키 확인 생략' 또는 ssh 로 한 번 접속)",
        Some(6) => " — 호스트 이름을 찾을 수 없습니다",
        Some(7) => " — 서버에 연결할 수 없습니다 (주소·포트·방화벽)",
        Some(9) | Some(78) => " — 원격 경로가 없거나 권한이 없습니다",
        Some(28) => " — 시간 초과",
        Some(35) | Some(60) => " — TLS/인증서 오류 ('인증서 확인 생략' 참고)",
        Some(51) => " — SFTP 호스트 키가 known_hosts 와 다릅니다",
        Some(67) => " — 로그인 실패 (사용자·비밀번호·키)",
        Some(25) => " — 업로드 거부 (쓰기 권한·디스크 용량)",
        Some(64) => " — 서버가 FTPS(TLS)를 지원하지 않습니다",
        _ => "",
    }
}

fn stderr_msg(o: &std::process::Output) -> String {
    format!("{}{}", stderr_msg_raw(o), hint(o))
}

fn stderr_msg_raw(o: &std::process::Output) -> String {
    let s = String::from_utf8_lossy(&o.stderr).trim().to_string();
    let s = if s.is_empty() { String::from_utf8_lossy(&o.stdout).trim().to_string() } else { s };
    let s: String = s.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").chars().take(300).collect();
    if s.is_empty() {
        format!("종료 코드 {}", o.status.code().unwrap_or(-1))
    } else {
        s
    }
}

impl Target {
    /// FTP·FTPS·SFTP 는 원격 루트(로그인 폴더·'/'·'~')에 쓰지 않는다 — 설정된 디렉터리가 꼭 있어야 한다.
    fn remote_base(&self) -> Result<String, String> {
        let b = self.path.trim().trim_start_matches("~/").trim_matches('/').trim();
        if b.is_empty() || b == "~" || b == "." {
            return Err("원격 경로(디렉터리)를 지정하세요 — 루트에는 쓰지 않습니다".into());
        }
        Ok(b.to_string())
    }

    fn scheme(&self) -> &str {
        match self.kind.as_str() {
            "ftps" => "ftp", // 명시적 TLS (AUTH TLS) — --ssl-reqd
            k => k,
        }
    }

    fn url(&self, remote: &str) -> String {
        let port = if self.port > 0 { format!(":{}", self.port) } else { String::new() };
        // SFTP: '/data/x' = 절대 경로, '~/x' = 홈 기준. FTP: 로그인 디렉터리 기준.
        let path = format!("/{}", join_remote(&self.path, remote).trim_start_matches('/'));
        format!("{}://{}{}{}", self.scheme(), self.host.trim(), port, enc(&path))
    }

    fn curl_cfg(&self) -> String {
        let mut c = String::new();
        if !self.username.is_empty() {
            c.push_str(&format!("user = {}\n", kq(&format!("{}:{}", self.username, self.password))));
        }
        if self.kind == "sftp" && !self.key_path.trim().is_empty() {
            c.push_str(&format!("key = {}\n", kq(self.key_path.trim())));
        }
        c
    }

    fn curl(&self, p: &Policy) -> Command {
        let mut cmd = Command::new("curl");
        cmd.args(["-sS", "--fail", "--connect-timeout", "10", "--max-time", &p.timeout_s.max(30).to_string(), "-K", "-"]);
        if self.kind == "ftps" {
            cmd.arg("--ssl-reqd");
        }
        if self.insecure {
            cmd.arg("-k");
        }
        cmd
    }

    fn smb_auth(&self, work: &Path) -> Result<PathBuf, String> {
        let f = work.join(format!("smb-auth-{}-{}", self.id, now_ms()));
        let body = format!("username = {}\npassword = {}\ndomain = {}\n", self.username, self.password, self.domain);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut h = fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&f).map_err(|e| e.to_string())?;
            h.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        fs::write(&f, body).map_err(|e| e.to_string())?;
        Ok(f)
    }

    fn smbclient(&self, auth: &Path, p: &Policy, cmds: &str) -> Result<std::process::Output, String> {
        let mut cmd = Command::new("timeout");
        cmd.arg(p.timeout_s.max(30).to_string()).arg("smbclient").arg(format!("//{}/{}", self.host.trim(), self.share.trim().trim_matches('/')));
        cmd.arg("-A").arg(auth).args(["-t", "60"]);
        if self.port > 0 {
            cmd.args(["-p", &self.port.to_string()]);
        }
        cmd.arg("-c").arg(cmds);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = spawn_tracked(&mut cmd).map_err(|e| format!("smbclient {e} — apt install smbclient 필요"))?;
        wait_tracked(child)
    }
}

impl Backup {
    pub fn open(db_path: &str, store_dir: &str) -> Arc<Self> {
        let db = Connection::open(db_path).unwrap_or_else(|e| {
            warn!("backup db open {} failed ({}): in-memory", db_path, e);
            Connection::open_in_memory().expect("in-memory sqlite")
        });
        let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
        if let Err(e) = db.execute_batch(SCHEMA) {
            warn!("backup schema: {}", e);
        }
        let root = PathBuf::from(store_dir);
        let work = root.join(".backup-tmp");
        let _ = fs::remove_dir_all(&work);
        let _ = fs::create_dir_all(&work);
        let policy: Policy = db
            .query_row("SELECT value FROM backup_kv WHERE key='policy'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut targets: Vec<Target> = Vec::new();
        if let Ok(mut st) = db.prepare("SELECT json FROM backup_targets ORDER BY position") {
            if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
                targets = rows.flatten().filter_map(|j| serde_json::from_str(&j).ok()).collect();
            }
        }
        let mut ledger: HashMap<String, Vec<Copy>> = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT rel, target, size, sha FROM backup_files") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Vec<u8>>(3)?))) {
                for (rel, target, size, sha) in rows.flatten() {
                    let mut s = [0u8; 32];
                    if sha.len() == 32 {
                        s.copy_from_slice(&sha);
                    }
                    ledger.entry(rel).or_default().push(Copy { target, size: size as u64, sha: s });
                }
            }
        }
        // 원격 파일 이름(늦게 온 레코드로 .late-… 이름이 된 경우 rel 과 다르다) — 옛 표에는 없어 추가
        let _ = db.execute("ALTER TABLE backup_catalog ADD COLUMN remote TEXT", []);
        // 대상별 목록이 생기기 전에 올린 사본(아직 로컬에 있는 것)을 목록에 채운다
        if let Ok(mut st) = db.prepare("SELECT rel, target, size, sha, done_ms FROM backup_files") {
            let rows: Vec<(String, String, i64, Vec<u8>, i64)> = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .map(|it| it.flatten().collect())
                .unwrap_or_default();
            drop(st);
            for (rel, target, size, sha, done) in rows {
                let _ = db.execute(
                    "INSERT OR IGNORE INTO backup_catalog (target, rel, hour, size, sha, done_ms, src) VALUES (?1,?2,?3,?4,?5,?6,'upload')",
                    params![target, rel, hour_of(&rel), size, sha, done],
                );
            }
        }
        let cutoff = now_ms().saturating_sub(14 * 86_400_000) as i64;
        let _ = db.execute("DELETE FROM backup_tombs WHERE deleted_ms < ?1", params![cutoff]);
        let mut tombs = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT rel, deleted_ms FROM backup_tombs") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                for (rel, ms) in rows.flatten() {
                    tombs.insert(rel, ms as u64);
                }
            }
        }
        info!("backup: {} targets ({} enabled), {} files in ledger, policy {:?}", targets.len(), targets.iter().filter(|t| t.enabled).count(), ledger.len(), policy);
        let b = Arc::new(Self {
            root,
            work,
            db: Mutex::new(db),
            policy: RwLock::new(policy),
            targets: RwLock::new(targets),
            stats: Mutex::new(HashMap::new()),
            log: Mutex::new(VecDeque::new()),
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            inflight: Mutex::new(HashSet::new()),
            ledger: Mutex::new(ledger),
            tombs: Mutex::new(tombs),
            smb_dirs: Mutex::new(HashSet::new()),
            pending: Mutex::new(Pending::default()),
            last_scan_ms: AtomicU64::new(0),
            scan_now: AtomicBool::new(true),
            unbacked_seen: AtomicU64::new(0),
        });
        b.apply_policy_globals();
        b.rebuild_safe();
        b
    }

    fn apply_policy_globals(&self) {
        let p = self.policy.read().unwrap();
        EMERGENCY_FREE_PCT.store(p.emergency_free_pct as u64, Ordering::Relaxed);
        crate::patch_store::BLOCK_HOURS.store(p.block_hours as u64, Ordering::Relaxed);
        ACTIVE.store(self.targets.read().unwrap().iter().any(|t| t.enabled), Ordering::Relaxed);
    }

    fn enabled_ids(&self) -> Vec<String> {
        self.targets.read().unwrap().iter().filter(|t| t.enabled).map(|t| t.id.clone()).collect()
    }

    fn need_copies(&self) -> usize {
        let n = self.enabled_ids().len();
        (self.policy.read().unwrap().copies.max(1) as usize).min(n.max(1))
    }

    /// 장부로 SAFE 재계산 (정책·대상 변경 시): 크기가 같은 활성 대상 사본이 필요 수 이상인 파일
    fn rebuild_safe(&self) {
        let ids: HashSet<String> = self.enabled_ids().into_iter().collect();
        let need = self.need_copies();
        SAFE.clear();
        if ids.is_empty() {
            return;
        }
        let ledger = self.ledger.lock().unwrap();
        for (rel, copies) in ledger.iter() {
            // 가장 최근 크기 기준 (파일은 커지기만 한다)
            let size = copies.iter().map(|c| c.size).max().unwrap_or(0);
            let n = copies.iter().filter(|c| c.size == size && ids.contains(&c.target)).count();
            if n >= need {
                SAFE.insert(rel.clone(), size);
            }
        }
    }

    fn save_targets(&self) {
        let ts = self.targets.read().unwrap().clone();
        let db = self.db.lock().unwrap();
        let _ = db.execute("DELETE FROM backup_targets", []);
        for (i, t) in ts.iter().enumerate() {
            if let Ok(j) = serde_json::to_string(t) {
                let _ = db.execute("INSERT INTO backup_targets (id, position, json) VALUES (?1,?2,?3)", params![t.id, i as i64, j]);
            }
        }
    }

    fn logit(&self, target: &str, rel: &str, bytes: u64, ms: u64, ok: bool, msg: String) {
        let mut l = self.log.lock().unwrap();
        l.push_front(LogEntry { ts_ms: now_ms(), target: target.into(), rel: rel.into(), bytes, ms, ok, msg });
        l.truncate(300);
    }

    // ---------------------------------------------------------------- API

    pub fn status(&self) -> serde_json::Value {
        let p = self.policy.read().unwrap().clone();
        let stats = self.stats.lock().unwrap().clone();
        let today = day_key(now_ms());
        let mut daily: HashMap<String, (i64, i64)> = HashMap::new();
        let mut total: HashMap<String, (i64, i64)> = HashMap::new();
        if let Ok(db) = self.db.lock() {
            if let Ok(mut st) = db.prepare("SELECT target, day, files, bytes FROM backup_daily") {
                if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))) {
                    for (t, d, f, b) in rows.flatten() {
                        let e = total.entry(t.clone()).or_default();
                        e.0 += f;
                        e.1 += b;
                        if d == today {
                            daily.insert(t, (f, b));
                        }
                    }
                }
            }
        }
        let targets: Vec<serde_json::Value> = self
            .targets
            .read()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut v = serde_json::to_value(t).unwrap_or_default();
                if let Some(o) = v.as_object_mut() {
                    o.remove("password");
                    o.insert("has_password".into(), (!t.password.is_empty()).into());
                    o.insert("priority".into(), (i + 1).into());
                    let mut s = stats.get(&t.id).cloned().unwrap_or_default();
                    if let Some(u) = s.down_until {
                        s.down_s = u.saturating_duration_since(Instant::now()).as_secs();
                    }
                    o.insert("stat".into(), serde_json::to_value(s).unwrap_or_default());
                    let d = daily.get(&t.id).copied().unwrap_or_default();
                    let tt = total.get(&t.id).copied().unwrap_or_default();
                    o.insert("today".into(), serde_json::json!({"files": d.0, "bytes": d.1}));
                    o.insert("total".into(), serde_json::json!({"files": tt.0, "bytes": tt.1}));
                }
                v
            })
            .collect();
        let (disk_total, disk_free) = volume_stats(&self.root);
        serde_json::json!({
            "policy": p,
            "targets": targets,
            "active": ACTIVE.load(Ordering::Relaxed),
            "need_copies": self.need_copies(),
            "pending": *self.pending.lock().unwrap(),
            "queue": self.queue.lock().unwrap().len(),
            "inflight": self.inflight.lock().unwrap().iter().cloned().collect::<Vec<_>>(),
            "last_scan_ms": self.last_scan_ms.load(Ordering::Relaxed),
            "blocked_bytes": BLOCKED_BYTES.load(Ordering::Relaxed),
            "unbacked_deleted": UNBACKED_DELETED.load(Ordering::Relaxed),
            "unbacked_deleted_bytes": UNBACKED_DELETED_BYTES.load(Ordering::Relaxed),
            "store_bytes": crate::patch_store::STORE_BYTES.load(Ordering::Relaxed),
            "disk_total": disk_total,
            "disk_free": disk_free,
            "log": *self.log.lock().unwrap(),
            "kinds": KINDS,
        })
    }

    pub fn set_policy(&self, mut p: Policy) -> Result<(), String> {
        if !["cap", "immediate"].contains(&p.delete_mode.as_str()) {
            return Err("delete_mode 는 cap | immediate".into());
        }
        if !["sha256", "size"].contains(&p.verify.as_str()) {
            return Err("verify 는 sha256 | size".into());
        }
        p.copies = p.copies.clamp(1, 8);
        p.parallel = p.parallel.clamp(1, 8);
        p.min_age_min = p.min_age_min.clamp(1, 24 * 60);
        p.emergency_free_pct = p.emergency_free_pct.clamp(1, 50);
        p.timeout_s = p.timeout_s.clamp(30, 7200);
        if !crate::patch_store::BLOCK_CHOICES.contains(&p.block_hours) {
            return Err(format!("저장 단위는 {:?} 시간 중 하나", crate::patch_store::BLOCK_CHOICES));
        }
        if let Ok(j) = serde_json::to_string(&p) {
            let _ = self.db.lock().unwrap().execute("INSERT OR REPLACE INTO backup_kv (key, value) VALUES ('policy', ?1)", params![j]);
        }
        *self.policy.write().unwrap() = p;
        self.apply_policy_globals();
        self.rebuild_safe();
        self.kick();
        Ok(())
    }

    fn validate(t: &Target) -> Result<(), String> {
        if !KINDS.contains(&t.kind.as_str()) {
            return Err(format!("종류는 {}", KINDS.join(" | ")));
        }
        if t.kind == "nas" {
            if !t.path.trim().starts_with('/') {
                return Err("NAS 는 마운트된 절대 경로가 필요합니다 (예: /mnt/nas/biomonitor)".into());
            }
        } else if t.host.trim().is_empty() {
            return Err("호스트가 필요합니다".into());
        }
        if matches!(t.kind.as_str(), "ftp" | "ftps" | "sftp") {
            t.remote_base()?;
        }
        if t.kind == "smb" && t.share.trim().is_empty() {
            return Err("SMB 공유 이름이 필요합니다".into());
        }
        Ok(())
    }

    pub fn create_target(&self, inp: TargetInput) -> Result<serde_json::Value, String> {
        let mut t = inp.t;
        Self::validate(&t)?;
        t.id = format!("t{}", now_ms());
        t.created_ms = now_ms();
        t.updated_ms = t.created_ms;
        if t.name.trim().is_empty() {
            t.name = format!("{} {}", t.kind.to_uppercase(), if t.kind == "nas" { t.path.clone() } else { t.host.clone() });
        }
        let id = t.id.clone();
        self.targets.write().unwrap().push(t);
        self.after_target_change();
        Ok(serde_json::json!({"id": id}))
    }

    pub fn update_target(&self, id: &str, inp: TargetInput) -> Result<(), String> {
        let mut t = inp.t;
        Self::validate(&t)?;
        {
            let mut ts = self.targets.write().unwrap();
            let cur = ts.iter_mut().find(|x| x.id == id).ok_or("대상 없음")?;
            if t.password.is_empty() && !inp.clear_password {
                t.password = cur.password.clone();
            }
            t.id = cur.id.clone();
            t.created_ms = cur.created_ms;
            t.updated_ms = now_ms();
            *cur = t;
        }
        self.smb_dirs.lock().unwrap().retain(|(tid, _)| tid != id);
        self.stats.lock().unwrap().entry(id.to_string()).or_default().down_until = None;
        self.after_target_change();
        Ok(())
    }

    pub fn delete_target(&self, id: &str) -> Result<(), String> {
        let before = self.targets.read().unwrap().len();
        self.targets.write().unwrap().retain(|t| t.id != id);
        if self.targets.read().unwrap().len() == before {
            return Err("대상 없음".into());
        }
        // 그 대상의 사본 기록은 남긴다(원격 파일은 그대로 있으니까) — 활성 대상이 아니므로 SAFE 계산에서만 빠진다
        self.after_target_change();
        Ok(())
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        {
            let mut ts = self.targets.write().unwrap();
            if ids.len() != ts.len() || !ids.iter().all(|i| ts.iter().any(|t| &t.id == i)) {
                return Err("모든 대상 id 를 한 번씩 보내야 합니다".into());
            }
            ts.sort_by_key(|t| ids.iter().position(|i| *i == t.id).unwrap_or(usize::MAX));
        }
        self.after_target_change();
        Ok(())
    }

    fn after_target_change(&self) {
        self.save_targets();
        self.apply_policy_globals();
        self.rebuild_safe();
        self.kick();
    }

    pub fn kick(&self) {
        self.scan_now.store(true, Ordering::Relaxed);
    }

    pub fn target(&self, id: &str) -> Option<Target> {
        self.targets.read().unwrap().iter().find(|t| t.id == id).cloned()
    }

    /// 입력값(저장 전)에 비밀번호가 비어 있고 같은 id 가 있으면 저장된 비밀번호를 쓴다
    pub fn resolve_for_test(&self, inp: TargetInput) -> Result<Target, String> {
        let mut t = inp.t;
        Self::validate(&t)?;
        if t.password.is_empty() && !inp.clear_password {
            if let Some(cur) = self.target(&t.id) {
                t.password = cur.password;
            }
        }
        if t.id.is_empty() {
            t.id = "test".into();
        }
        Ok(t)
    }

    /// 연결 시험: 작은 파일을 올리고, 다시 읽어 SHA-256 을 비교하고, 지운다.
    pub fn test_target(&self, t: &Target) -> serde_json::Value {
        let p = self.policy.read().unwrap().clone();
        let body = format!("biomonitor router backup test {} {}\n", now_ms(), hostname());
        let local = self.work.join(format!("test-{}-{}.txt", t.id, now_ms()));
        let mut steps: Vec<serde_json::Value> = Vec::new();
        if let Err(e) = fs::write(&local, &body) {
            return serde_json::json!({"ok": false, "steps": [{"step": "준비", "ok": false, "msg": e.to_string()}]});
        }
        let remote = format!(".biomonitor-test-{}.txt", now_ms());
        let (sha, size) = sha_file(&local).unwrap_or(([0; 32], 0));
        let t0 = Instant::now();
        let up = self.upload(t, &p, &local, &remote, size, &sha, true);
        let ms = t0.elapsed().as_millis() as u64;
        let ok = up.is_ok();
        steps.push(serde_json::json!({"step": "쓰기 + 다시 읽기(SHA-256 비교)", "ok": ok, "ms": ms, "msg": up.err().unwrap_or_else(|| format!("{} 바이트 일치", size))}));
        if ok {
            let del = self.remove_remote(t, &p, &remote);
            steps.push(serde_json::json!({"step": "시험 파일 삭제", "ok": del.is_ok(), "msg": del.err().unwrap_or_default()}));
        }
        let _ = fs::remove_file(&local);
        serde_json::json!({"ok": ok, "steps": steps, "where": self.describe(t, &remote)})
    }

    /// 백업 중단: 전송 일시 중지 + 대기열 비움 + 전송 중인 curl/smbclient 즉시 종료. 재개는 정책의 일시 중지 해제.
    pub fn abort(&self) -> Result<usize, String> {
        let mut p = self.policy.read().unwrap().clone();
        p.paused = true;
        self.set_policy(p)?;
        ABORT_GEN.fetch_add(1, Ordering::Relaxed);
        self.queue.lock().unwrap().clear();
        let pids: Vec<u32> = CHILDREN.lock().unwrap().iter().copied().collect();
        #[cfg(unix)]
        for pid in &pids {
            unsafe {
                libc::kill(*pid as i32, libc::SIGTERM);
            }
        }
        self.cv.notify_all();
        info!("backup: aborted by user ({} transfers killed)", pids.len());
        Ok(pids.len())
    }

    /// 대상의 백업 파일 전체 삭제: 설정된 디렉터리 안의 `patches/` 만 지운다(루트·다른 폴더는 건드리지 않음).
    /// 먼저 백업을 중단한다. 끝나면 이 대상의 목록·사본 기록을 비워, 로컬에 남은 파일은 재개 뒤 다시 올라간다.
    pub fn purge_target(self: &Arc<Self>, target: &str) -> Result<(), String> {
        let t = self.target(target).ok_or("대상 없음")?;
        if t.kind == "nas" {
            if !t.path.trim().starts_with('/') || t.path.trim().trim_matches('/').is_empty() {
                return Err("NAS 경로가 올바르지 않습니다".into());
            }
        } else {
            t.remote_base()?;
        }
        {
            let mut s = SYNC.lock().unwrap();
            if s.get(target).and_then(|v| v["running"].as_bool()) == Some(true) {
                return Err("이 대상에서 다른 작업이 진행 중입니다".into());
            }
            s.insert(target.into(), serde_json::json!({ "op": "purge", "running": true, "started_ms": now_ms(), "dirs": 0, "deleted": 0 }));
        }
        self.abort()?;
        let b = self.clone();
        std::thread::Builder::new()
            .name("backup-purge".into())
            .spawn(move || {
                let r = b.purge_run(&t);
                let mut s = SYNC.lock().unwrap();
                let e = s.entry(t.id.clone()).or_default();
                e["running"] = serde_json::json!(false);
                e["done_ms"] = serde_json::json!(now_ms());
                if let Err(err) = r {
                    e["error"] = serde_json::json!(err);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn purge_run(&self, t: &Target) -> Result<(), String> {
        let p = self.policy.read().unwrap().clone();
        let set = |k: &str, v: serde_json::Value| {
            if let Some(e) = SYNC.lock().unwrap().get_mut(&t.id) {
                e[k] = v;
            }
        };
        let mut deleted = 0u64;
        match t.kind.as_str() {
            "nas" => {
                let dir = Path::new(t.path.trim()).join("patches");
                if dir.is_dir() {
                    deleted = fs::read_dir(&dir).map(|rd| rd.flatten().filter_map(|d| fs::read_dir(d.path()).ok()).map(|f| f.count() as u64).sum()).unwrap_or(0);
                    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
                }
            }
            "smb" => {
                let auth = t.smb_auth(&self.work)?;
                let full = join_remote(&t.path, "patches").trim_start_matches('/').to_string();
                let o = t.smbclient(&auth, &p, &format!("deltree \"{full}\""));
                let _ = fs::remove_file(&auth);
                let o = o?;
                if !o.status.success() && !String::from_utf8_lossy(&o.stderr).contains("NT_STATUS_OBJECT_NAME_NOT_FOUND") {
                    return Err(stderr_msg(&o));
                }
            }
            kind => {
                let dirs: Vec<String> = match self.list_remote(t, &p, "patches") {
                    Ok(v) => v.into_iter().filter(|x| x.2).map(|x| x.0).collect(),
                    Err(e) if e.contains("(9)") || e.contains("(78)") => Vec::new(), // patches/ 가 없다 = 지울 것 없음
                    Err(e) => return Err(e),
                };
                set("dirs_total", serde_json::json!(dirs.len()));
                // SFTP 명령 경로: '/..' 절대, 아니면 홈 기준
                let sftp_path = |rel: &str| {
                    let full = join_remote(&t.path, rel);
                    if t.path.trim().starts_with('/') { format!("/{}", full.trim_start_matches('/')) } else { full.trim_start_matches("~/").to_string() }
                };
                let mut done = 0usize;
                for chunk in dirs.chunks(50) {
                    let subs: Vec<String> = chunk.iter().map(|d| format!("patches/{d}")).collect();
                    let lists = self.list_remote_many(t, &p, &subs);
                    let mut q: Vec<String> = Vec::new();
                    for (d, r) in chunk.iter().zip(lists) {
                        for (name, _, is_dir) in r.unwrap_or_default() {
                            if is_dir {
                                continue;
                            }
                            deleted += 1;
                            q.push(if kind == "sftp" { format!("-*rm \"{}\"", sftp_path(&format!("patches/{d}/{name}"))) } else { format!("-*DELE {d}/{name}") });
                        }
                        q.push(if kind == "sftp" { format!("-*rmdir \"{}\"", sftp_path(&format!("patches/{d}"))) } else { format!("-*RMD {d}") });
                    }
                    // patches/ 목록을 받은 뒤(-) 그 안에서 명령 실행, 실패한 명령(*)은 건너뛰고 계속
                    let mut cmd = t.curl(&p);
                    cmd.args(["-o", "/dev/null"]);
                    for c in &q {
                        cmd.arg("-Q").arg(c);
                    }
                    cmd.arg(format!("{}/", t.url("patches").trim_end_matches('/')));
                    let o = run_with_stdin(cmd, &t.curl_cfg())?;
                    if !o.status.success() {
                        return Err(format!("삭제 실패: {}", stderr_msg(&o)));
                    }
                    done += chunk.len();
                    set("dirs", serde_json::json!(done));
                    set("deleted", serde_json::json!(deleted));
                }
                let mut cmd = t.curl(&p);
                let rm = if kind == "sftp" { format!("-*rmdir \"{}\"", sftp_path("patches")) } else { "-*RMD patches".to_string() };
                cmd.args(["-o", "/dev/null", "-Q", &rm]).arg(format!("{}/", t.url("").trim_end_matches('/')));
                let _ = run_with_stdin(cmd, &t.curl_cfg());
            }
        }
        // 이 대상의 기록 비우기 → 로컬에 남은 파일은 백업 안 된 것으로 돌아가 재개 뒤 다시 올라간다
        {
            let mut led = self.ledger.lock().unwrap();
            for v in led.values_mut() {
                v.retain(|c| c.target != t.id);
            }
            led.retain(|_, v| !v.is_empty());
        }
        if let Ok(db) = self.db.lock() {
            let _ = db.execute("DELETE FROM backup_catalog WHERE target = ?1", params![t.id]);
            let _ = db.execute("DELETE FROM backup_files WHERE target = ?1", params![t.id]);
        }
        self.rebuild_safe();
        set("deleted", serde_json::json!(deleted));
        info!("backup: purged target {} — {} files deleted", t.name, deleted);
        Ok(())
    }

    // ---------------------------------------------------------------- 백업에서 다시 읽기 (히스토리)

    /// 백업 목록에 있는 이 패치의 파일: (키, rel, 크기) — 로컬에 없어도 히스토리 목록에 보이게
    pub fn remote_blocks(&self, patch_id: u32) -> Vec<(String, String, u64)> {
        let like = format!("patches/{patch_id:08}/%");
        let db = self.db.lock().unwrap();
        let Ok(mut st) = db.prepare("SELECT rel, MAX(size) FROM backup_catalog WHERE rel LIKE ?1 GROUP BY rel") else { return Vec::new() };
        let rows: Vec<(String, i64)> = st.query_map(params![like], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.flatten().collect()).unwrap_or_default();
        rows.into_iter().map(|(rel, size)| (hour_of(&rel), rel, size.max(0) as u64)).collect()
    }

    /// [from, to) 에 걸치는 이 패치의 파일 중 로컬에 없고 백업에만 있는 것을 받아 온다(최대 max 개).
    /// 이미 받아 둔 것(복원 캐시)은 다시 받지 않는다. 반환: (받은 수, 실패 메시지들)
    pub fn ensure_local(&self, patch_id: u32, from_ms: u64, to_ms: u64, max: usize) -> (usize, Vec<String>) {
        let local: HashSet<String> = crate::patch_store::list_files(&self.root, patch_id).into_iter().map(|x| x.0).collect();
        let mut want: Vec<(String, String)> = self
            .remote_blocks(patch_id)
            .into_iter()
            .filter(|(k, _, _)| !local.contains(k) && crate::patch_store::key_range(k).map(|(a, b)| a < to_ms && b > from_ms).unwrap_or(false))
            .map(|(k, rel, _)| (k, rel))
            .collect();
        want.sort();
        want.truncate(max);
        let (mut n, mut errs) = (0usize, Vec::new());
        for (_, rel) in want {
            match self.restore(patch_id, &rel) {
                Ok(_) => n += 1,
                Err(e) => errs.push(format!("{rel}: {e}")),
            }
        }
        (n, errs)
    }

    /// 백업에서 파일 하나를 복원 캐시로 받는다: 대상 순위대로 시도, SHA-256(업로드 때 값, 없으면 원격 .sum)으로 검증
    fn restore(&self, patch_id: u32, rel: &str) -> Result<PathBuf, String> {
        static LOCKS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        let dir = crate::patch_store::restore_dir(&self.root, patch_id);
        let dest = dir.join(&name);
        // 같은 파일을 두 요청이 동시에 받지 않게 (먼저 받은 쪽을 기다렸다가 결과를 쓴다)
        loop {
            if dest.exists() {
                return Ok(dest);
            }
            if LOCKS.lock().unwrap().insert(rel.to_string()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let res = (|| {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let rows: Vec<(String, i64, Option<Vec<u8>>, Option<String>)> = {
                let db = self.db.lock().unwrap();
                let mut st = db.prepare("SELECT target, size, sha, remote FROM backup_catalog WHERE rel = ?1").map_err(|e| e.to_string())?;
                let v = st.query_map(params![rel], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|e| e.to_string())?.flatten().collect();
                v
            };
            if rows.is_empty() {
                return Err("백업 목록에 없음".into());
            }
            let p = self.policy.read().unwrap().clone();
            let targets = self.targets.read().unwrap().clone();
            let mut last = String::from("백업 대상 없음");
            for t in targets.iter().filter(|t| rows.iter().any(|r| r.0 == t.id)) {
                let (_, size, sha, remote) = rows.iter().find(|r| r.0 == t.id).cloned().unwrap();
                let remote = remote.filter(|r| !r.is_empty()).unwrap_or_else(|| rel.to_string());
                let tmp = dir.join(format!(".{name}.part"));
                if let Err(e) = self.download(t, &p, &remote, &tmp) {
                    last = format!("{}: {e}", t.name);
                    let _ = fs::remove_file(&tmp);
                    continue;
                }
                let (h, n) = sha_file(&tmp).map_err(|e| e.to_string())?;
                // 기대 해시: 업로드 때 적어 둔 값, 없으면(원격 목록 읽기로 찾은 파일) 원격 봉인 파일의 sha256
                let want = sha.filter(|s| s.len() == 32).or_else(|| {
                    let stem = remote.strip_suffix(".rec.gz").or_else(|| remote.strip_suffix(".rec")).unwrap_or(&remote);
                    let st = dir.join(format!(".{name}.sum.part"));
                    let got = self.download(t, &p, &format!("{stem}.sum"), &st).ok().and_then(|_| fs::read_to_string(&st).ok());
                    let _ = fs::remove_file(&st);
                    got.and_then(|j| serde_json::from_str::<crate::patch_store::Seal>(&j).ok()).and_then(|s| seal_sha(&s)).map(|a| a.to_vec())
                });
                let ok = match &want {
                    Some(w) => w.as_slice() == h.as_slice(),
                    None => size <= 0 || n == size as u64,
                };
                if !ok {
                    last = format!("{}: 받은 파일 검증 실패 (SHA-256/크기 불일치)", t.name);
                    let _ = fs::remove_file(&tmp);
                    continue;
                }
                fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
                info!("backup: restored {} from {} for history ({} KB)", rel, t.name, n >> 10);
                return Ok(dest.clone());
            }
            Err(last)
        })();
        LOCKS.lock().unwrap().remove(rel);
        if res.is_ok() {
            self.prune_restore_cache(5 << 30);
        }
        res
    }

    /// 원격 파일 하나를 로컬 경로로 받는다
    fn download(&self, t: &Target, p: &Policy, remote: &str, dest: &Path) -> Result<(), String> {
        match t.kind.as_str() {
            "nas" => fs::copy(Path::new(t.path.trim()).join(remote), dest).map(|_| ()).map_err(|e| e.to_string()),
            "smb" => {
                let auth = t.smb_auth(&self.work)?;
                let full = join_remote(&t.path, remote).trim_start_matches('/').to_string();
                let o = t.smbclient(&auth, p, &format!("get \"{}\" \"{}\"", full, dest.display()));
                let _ = fs::remove_file(&auth);
                let o = o?;
                if o.status.success() && dest.exists() { Ok(()) } else { Err(stderr_msg(&o)) }
            }
            _ => {
                let mut cmd = t.curl(p);
                cmd.arg("-o").arg(dest).arg(t.url(remote));
                let o = run_with_stdin(cmd, &t.curl_cfg())?;
                if o.status.success() { Ok(()) } else { Err(stderr_msg(&o)) }
            }
        }
    }

    /// 복원 캐시가 cap 을 넘으면 오래 안 쓴(수정 시각이 오래된) 파일부터 지운다
    fn prune_restore_cache(&self, cap: u64) {
        let base = self.root.join(crate::patch_store::RESTORE_DIR).join("patches");
        let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
        if let Ok(rd) = fs::read_dir(&base) {
            for d in rd.flatten() {
                if let Ok(fs2) = fs::read_dir(d.path()) {
                    for f in fs2.flatten() {
                        if let Ok(m) = f.metadata() {
                            files.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), f.path()));
                        }
                    }
                }
            }
        }
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= cap {
            return;
        }
        files.sort();
        for (_, n, path) in files {
            if total <= cap / 10 * 9 {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(n);
            }
        }
    }

    // ---------------------------------------------------------------- 대상별 백업 목록

    /// hour 없으면 시간별 요약, 있으면 그 시간의 파일 목록 (q = 패치 번호 일부)
    pub fn catalog(&self, target: &str, hour: Option<&str>, q: &str) -> serde_json::Value {
        let db = self.db.lock().unwrap();
        let (files, bytes): (i64, i64) = db
            .query_row("SELECT COUNT(*), COALESCE(SUM(size),0) FROM backup_catalog WHERE target = ?1", params![target], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or((0, 0));
        let sync = SYNC.lock().unwrap().get(target).cloned();
        let mut out = serde_json::json!({ "target": target, "files": files, "bytes": bytes, "sync": sync });
        if let Some(h) = hour {
            let like = format!("%{}%", q.trim());
            let mut v = Vec::new();
            if let Ok(mut st) = db.prepare(
                "SELECT rel, size, sha, done_ms, src FROM backup_catalog WHERE target = ?1 AND hour = ?2 AND rel LIKE ?3 ORDER BY rel LIMIT 5000",
            ) {
                if let Ok(rows) = st.query_map(params![target, h, like], |r| {
                    let rel: String = r.get(0)?;
                    let sha: Option<Vec<u8>> = r.get(2)?;
                    Ok(serde_json::json!({
                        "rel": rel, "patch": rel.split('/').nth(1).unwrap_or(""), "size": r.get::<_, i64>(1)?,
                        "sha": sha.filter(|s| s.len() == 32).map(|s| hex(&s)), "done_ms": r.get::<_, i64>(3)?, "src": r.get::<_, String>(4)?,
                    }))
                }) {
                    v.extend(rows.flatten());
                }
            }
            out["hour"] = serde_json::json!(h);
            out["list"] = serde_json::json!(v);
        } else {
            let mut v = Vec::new();
            if let Ok(mut st) = db.prepare(
                "SELECT hour, COUNT(*), SUM(size), MIN(done_ms), MAX(done_ms), SUM(src = 'remote') FROM backup_catalog WHERE target = ?1 GROUP BY hour ORDER BY hour DESC LIMIT 2000",
            ) {
                if let Ok(rows) = st.query_map(params![target], |r| {
                    Ok(serde_json::json!({ "hour": r.get::<_, String>(0)?, "files": r.get::<_, i64>(1)?, "bytes": r.get::<_, i64>(2)?,
                                           "first_ms": r.get::<_, i64>(3)?, "last_ms": r.get::<_, i64>(4)?, "remote_only": r.get::<_, i64>(5)? }))
                }) {
                    v.extend(rows.flatten());
                }
            }
            out["hours"] = serde_json::json!(v);
        }
        out
    }

    /// 원격 저장소의 patches/ 를 읽어 목록에 없는 파일을 채운다 (백그라운드). 목록에 있는데 원격에 없는 건 세기만 한다.
    pub fn sync_catalog(self: &Arc<Self>, target: &str) -> Result<(), String> {
        let t = self.target(target).ok_or("대상 없음")?;
        if t.kind == "smb" {
            return Err("SMB 대상은 아직 원격 목록 읽기를 지원하지 않습니다".into());
        }
        if t.kind != "nas" {
            t.remote_base()?;
        }
        {
            let mut s = SYNC.lock().unwrap();
            if s.get(target).and_then(|v| v["running"].as_bool()) == Some(true) {
                return Err("이 대상에서 다른 작업이 진행 중입니다".into());
            }
            s.insert(target.into(), serde_json::json!({ "op": "sync", "running": true, "started_ms": now_ms(), "dirs": 0, "found": 0, "added": 0 }));
        }
        let b = self.clone();
        std::thread::Builder::new()
            .name("backup-sync".into())
            .spawn(move || {
                let r = b.sync_run(&t);
                let mut s = SYNC.lock().unwrap();
                let e = s.entry(t.id.clone()).or_default();
                e["running"] = serde_json::json!(false);
                e["done_ms"] = serde_json::json!(now_ms());
                if let Err(err) = r {
                    e["error"] = serde_json::json!(err);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 원격 디렉터리 한 곳 (patches 아래 상대 경로) 목록
    fn list_remote(&self, t: &Target, p: &Policy, sub: &str) -> Result<Vec<(String, Option<u64>, bool)>, String> {
        if t.kind == "nas" {
            let rd = fs::read_dir(Path::new(t.path.trim()).join(sub)).map_err(|e| e.to_string())?;
            return Ok(rd
                .flatten()
                .map(|e| {
                    let md = e.metadata().ok();
                    (e.file_name().to_string_lossy().to_string(), md.as_ref().map(|m| m.len()), md.map(|m| m.is_dir()).unwrap_or(false))
                })
                .collect());
        }
        let mut cmd = t.curl(p);
        cmd.arg(format!("{}/", t.url(sub).trim_end_matches('/')));
        let o = run_with_stdin(cmd, &t.curl_cfg())?;
        if !o.status.success() {
            return Err(format!("{sub}: {}", stderr_msg(&o)));
        }
        Ok(String::from_utf8_lossy(&o.stdout).lines().filter_map(parse_list_line).collect())
    }

    /// 여러 디렉터리를 curl 한 번(연결 재사용)으로 읽는다. 각 결과는 subs 순서대로.
    fn list_remote_many(&self, t: &Target, p: &Policy, subs: &[String]) -> Vec<Result<Vec<(String, Option<u64>, bool)>, String>> {
        if t.kind == "nas" {
            return subs.iter().map(|s| self.list_remote(t, p, s)).collect();
        }
        const MARK: &str = "@@BM_END@@";
        let mut cmd = t.curl(p);
        // --fail 로 한 폴더가 실패해도 다음 URL 은 계속 받는다. 폴더마다 끝 표시 + 응답 코드
        cmd.args(["-w", &format!("\n{MARK} %{{response_code}}\n")]);
        for sub in subs {
            cmd.arg(format!("{}/", t.url(sub).trim_end_matches('/')));
        }
        let o = match run_with_stdin(cmd, &t.curl_cfg()) {
            Ok(o) => o,
            Err(e) => return subs.iter().map(|_| Err(e.clone())).collect(),
        };
        let out = String::from_utf8_lossy(&o.stdout).to_string();
        let mut res = Vec::new();
        let mut cur = Vec::new();
        for l in out.lines() {
            if let Some(code) = l.strip_prefix(MARK) {
                let c: u32 = code.trim().parse().unwrap_or(0);
                // FTP 150/125/226/250 = 목록 성공, SFTP 는 0
                res.push(if c < 400 { Ok(std::mem::take(&mut cur)) } else { cur.clear(); Err(format!("응답 {c}")) });
            } else if let Some(x) = parse_list_line(l) {
                cur.push(x);
            }
        }
        while res.len() < subs.len() {
            res.push(Err(stderr_msg(&o)));
        }
        res
    }

    fn sync_run(&self, t: &Target) -> Result<(), String> {
        let p = self.policy.read().unwrap().clone();
        let set = |k: &str, v: serde_json::Value| {
            if let Some(e) = SYNC.lock().unwrap().get_mut(&t.id) {
                e[k] = v;
            }
        };
        let dirs: Vec<String> = self.list_remote(t, &p, "patches")?.into_iter().filter(|x| x.2).map(|x| x.0).collect();
        set("dirs_total", serde_json::json!(dirs.len()));
        let known: HashSet<String> = {
            let db = self.db.lock().unwrap();
            let mut st = db.prepare("SELECT rel FROM backup_catalog WHERE target = ?1").map_err(|e| e.to_string())?;
            let v: HashSet<String> = st.query_map(params![t.id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.flatten().collect();
            v
        };
        let (mut found, mut added, mut errs) = (0u64, 0u64, 0u64);
        let mut seen: HashSet<String> = HashSet::new();
        let mut done_dirs = 0usize;
        for chunk in dirs.chunks(100) {
          let subs: Vec<String> = chunk.iter().map(|d| format!("patches/{d}")).collect();
          let lists = self.list_remote_many(t, &p, &subs);
          for (d, r) in chunk.iter().zip(lists) {
            done_dirs += 1;
            let files = match r {
                Ok(f) => f,
                Err(_) => {
                    errs += 1;
                    continue;
                }
            };
            let mut new = Vec::new();
            for (name, size, is_dir) in files {
                if is_dir || !(name.ends_with(".rec") || name.ends_with(".rec.gz")) {
                    continue;
                }
                let rel = format!("patches/{d}/{name}");
                found += 1;
                if !known.contains(&rel) {
                    new.push((rel.clone(), size.unwrap_or(0)));
                }
                seen.insert(rel);
            }
            if !new.is_empty() {
                let mut db = self.db.lock().unwrap();
                if let Ok(tx) = db.transaction() {
                    for (rel, size) in &new {
                        let _ = tx.execute(
                            "INSERT OR IGNORE INTO backup_catalog (target, rel, hour, size, sha, done_ms, src) VALUES (?1,?2,?3,?4,NULL,?5,'remote')",
                            params![t.id, rel, hour_of(rel), *size as i64, now_ms() as i64],
                        );
                    }
                    let _ = tx.commit();
                }
                added += new.len() as u64;
            }
          }
          set("dirs", serde_json::json!(done_dirs));
          set("found", serde_json::json!(found));
          set("added", serde_json::json!(added));
        }
        let missing = known.iter().filter(|r| !seen.contains(*r)).count();
        set("missing", serde_json::json!(missing));
        set("dir_errors", serde_json::json!(errs));
        info!("backup: catalog sync {} — {} dirs, {} files found, {} added, {} listed but not on remote", t.name, dirs.len(), found, added, missing);
        Ok(())
    }

    fn describe(&self, t: &Target, remote: &str) -> String {
        match t.kind.as_str() {
            "nas" => Path::new(&t.path).join(remote).display().to_string(),
            "smb" => format!("//{}/{}/{}", t.host, t.share, join_remote(&t.path, remote).trim_start_matches('/')),
            _ => t.url(remote),
        }
    }

    // ---------------------------------------------------------------- transfer

    /// 올리고 검증까지. `force_sha` = 정책과 무관하게 다시 읽어 해시 비교 (연결 시험)
    fn upload(&self, t: &Target, p: &Policy, local: &Path, remote: &str, size: u64, sha: &[u8; 32], force_sha: bool) -> Result<(), String> {
        let by_sha = force_sha || p.verify == "sha256";
        match t.kind.as_str() {
            "nas" => {
                let base = Path::new(t.path.trim());
                if !base.is_dir() {
                    return Err(format!("경로 없음: {} (NAS 가 마운트되어 있나요?)", base.display()));
                }
                #[cfg(unix)]
                if !t.insecure {
                    use std::os::unix::fs::MetadataExt;
                    let a = fs::metadata(base).map(|m| m.dev()).unwrap_or(0);
                    let b = fs::metadata(&self.root).map(|m| m.dev()).unwrap_or(1);
                    if a == b {
                        return Err(format!("{} 가 로컬 저장소와 같은 디스크입니다 — NAS 가 마운트되지 않았습니다 (의도한 경우 '마운트 확인 생략')", base.display()));
                    }
                }
                let dst = base.join(remote);
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
                }
                let tmp = dst.with_file_name(format!(".{}.part", dst.file_name().unwrap_or_default().to_string_lossy()));
                (|| -> std::io::Result<()> {
                    let mut src = File::open(local)?;
                    let mut out = File::create(&tmp)?;
                    std::io::copy(&mut src, &mut out)?;
                    out.sync_all()?;
                    fs::rename(&tmp, &dst)
                })()
                .map_err(|e| {
                    let _ = fs::remove_file(&tmp);
                    format!("복사 실패: {e}")
                })?;
                if by_sha {
                    // 페이지 캐시가 아닌 원격 내용을 읽도록 보장할 수는 없지만(NFS/CIFS 캐시), 이름 바꾼 최종 파일을 다시 연다
                    let (h, n) = sha_file(&dst).map_err(|e| format!("다시 읽기 실패: {e}"))?;
                    check(n, size, &h, sha)
                } else {
                    let n = fs::metadata(&dst).map(|m| m.len()).map_err(|e| e.to_string())?;
                    if n == size {
                        Ok(())
                    } else {
                        Err(format!("크기 불일치: 원격 {n} ≠ 로컬 {size}"))
                    }
                }
            }
            "smb" => {
                let auth = t.smb_auth(&self.work)?;
                let res = (|| {
                    let full = join_remote(&t.path, remote).trim_start_matches('/').to_string();
                    // 폴더 만들기 (이미 있으면 오류가 나도 무시) — 대상별 캐시
                    let dirs: Vec<String> = {
                        let parts: Vec<&str> = full.split('/').collect();
                        (1..parts.len()).map(|i| parts[..i].join("/")).collect()
                    };
                    let missing: Vec<String> = {
                        let c = self.smb_dirs.lock().unwrap();
                        dirs.into_iter().filter(|d| !c.contains(&(t.id.clone(), d.clone()))).collect()
                    };
                    if !missing.is_empty() {
                        let cmds: Vec<String> = missing.iter().map(|d| format!("mkdir \"{d}\"")).collect();
                        let _ = t.smbclient(&auth, p, &cmds.join("; "));
                    }
                    let o = t.smbclient(&auth, p, &format!("put \"{}\" \"{}\"", local.display(), full))?;
                    if !o.status.success() || String::from_utf8_lossy(&o.stdout).contains("NT_STATUS") {
                        return Err(format!("업로드 실패: {}", stderr_msg(&o)));
                    }
                    {
                        let mut c = self.smb_dirs.lock().unwrap();
                        for d in missing {
                            c.insert((t.id.clone(), d));
                        }
                    }
                    if by_sha {
                        let back = self.work.join(format!("verify-{}-{}", t.id, now_ms()));
                        let o = t.smbclient(&auth, p, &format!("get \"{}\" \"{}\"", full, back.display()))?;
                        let r = if !o.status.success() {
                            Err(format!("다시 읽기 실패: {}", stderr_msg(&o)))
                        } else {
                            sha_file(&back).map_err(|e| format!("다시 읽기 실패: {e}")).and_then(|(h, n)| check(n, size, &h, sha))
                        };
                        let _ = fs::remove_file(&back);
                        r
                    } else {
                        let o = t.smbclient(&auth, p, &format!("allinfo \"{}\"", full))?;
                        let out = String::from_utf8_lossy(&o.stdout).to_string();
                        let n = out
                            .lines()
                            .find_map(|l| l.trim().strip_prefix("stream: [::$DATA],").map(|x| x.trim().split_whitespace().next().unwrap_or("").to_string()))
                            .and_then(|x| x.parse::<u64>().ok());
                        match n {
                            Some(n) if n == size => Ok(()),
                            Some(n) => Err(format!("크기 불일치: 원격 {n} ≠ 로컬 {size}")),
                            None => Err(format!("원격 크기 확인 실패: {}", stderr_msg(&o))),
                        }
                    }
                })();
                let _ = fs::remove_file(&auth);
                res
            }
            _ => {
                // 먼저 설정된 디렉터리로 들어가 본다(없으면 만들지 않고 실패). 그 안에서만 하위 폴더를 만들고 쓴다.
                t.remote_base()?;
                let key = format!("{}|{}", t.id, t.path.trim());
                let fresh = BASE_OK.lock().unwrap().get(&key).is_some_and(|&ms| now_ms().saturating_sub(ms) < 600_000);
                if !fresh {
                    let mut cmd = t.curl(p);
                    cmd.args(["--list-only", "-o", "/dev/null"]).arg(format!("{}/", t.url("").trim_end_matches('/')));
                    let o = run_with_stdin(cmd, &t.curl_cfg())?;
                    if !o.status.success() {
                        return Err(format!("설정된 디렉터리 '{}' 에 들어갈 수 없습니다 (없거나 권한 없음 — 서버에 먼저 만들어 두세요): {}", t.path.trim(), stderr_msg(&o)));
                    }
                    BASE_OK.lock().unwrap().insert(key, now_ms());
                }
                let url = t.url(remote);
                let mut cmd = t.curl(p);
                cmd.arg("--ftp-create-dirs").arg("-T").arg(local).arg(&url);
                if p.rate_limit_kbps > 0 {
                    cmd.args(["--limit-rate", &format!("{}k", p.rate_limit_kbps)]);
                }
                let o = run_with_stdin(cmd, &t.curl_cfg())?;
                if !o.status.success() {
                    return Err(format!("업로드 실패: {}", stderr_msg(&o)));
                }
                if by_sha {
                    let mut cmd = t.curl(p);
                    cmd.arg(&url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                    let mut child = spawn_tracked(&mut cmd).map_err(|e| format!("curl {e}"))?;
                    if let Some(mut si) = child.stdin.take() {
                        let _ = si.write_all(t.curl_cfg().as_bytes());
                    }
                    let res = sha_reader(child.stdout.take().unwrap());
                    let o = wait_tracked(child)?;
                    if !o.status.success() {
                        return Err(format!("다시 읽기 실패: {}", stderr_msg(&o)));
                    }
                    let (h, n) = res.map_err(|e| format!("다시 읽기 실패: {e}"))?;
                    check(n, size, &h, sha)
                } else {
                    let mut cmd = t.curl(p);
                    cmd.arg("-I").arg(&url);
                    let o = run_with_stdin(cmd, &t.curl_cfg())?;
                    let out = String::from_utf8_lossy(&o.stdout).to_string();
                    let n = out.lines().find_map(|l| {
                        let l = l.trim();
                        l.to_ascii_lowercase().strip_prefix("content-length:").map(|x| x.trim().to_string())
                    });
                    match n.and_then(|x| x.parse::<u64>().ok()) {
                        Some(n) if n == size => Ok(()),
                        Some(n) => Err(format!("크기 불일치: 원격 {n} ≠ 로컬 {size}")),
                        None => Err(format!("원격 크기 확인 실패 (서버가 SIZE 를 지원하지 않으면 SHA-256 검증을 쓰세요): {}", stderr_msg(&o))),
                    }
                }
            }
        }
    }

    fn remove_remote(&self, t: &Target, p: &Policy, remote: &str) -> Result<(), String> {
        match t.kind.as_str() {
            "nas" => fs::remove_file(Path::new(t.path.trim()).join(remote)).map_err(|e| e.to_string()),
            "smb" => {
                let auth = t.smb_auth(&self.work)?;
                let full = join_remote(&t.path, remote).trim_start_matches('/').to_string();
                let o = t.smbclient(&auth, p, &format!("del \"{full}\""));
                let _ = fs::remove_file(&auth);
                let o = o?;
                if o.status.success() {
                    Ok(())
                } else {
                    Err(stderr_msg(&o))
                }
            }
            kind => {
                // 디렉터리 URL 에 대해 명령만 실행 (목록 전송 뒤)
                let full = join_remote(&t.path, remote);
                let (dir, name) = match full.rsplit_once('/') {
                    Some((d, n)) => (d.to_string(), n.to_string()),
                    None => (String::new(), full.clone()),
                };
                let mut dt = t.clone();
                dt.path = dir.clone();
                let url = dt.url("");
                let q = if kind == "sftp" {
                    let abs = if t.path.trim().starts_with('/') { format!("/{}", full.trim_start_matches('/')) } else { full.trim_start_matches("~/").to_string() };
                    format!("-rm \"{abs}\"")
                } else {
                    format!("-DELE {name}")
                };
                let mut cmd = t.curl(p);
                cmd.args(["-o", "/dev/null", "-Q", &q]).arg(format!("{}/", url.trim_end_matches('/')));
                let o = run_with_stdin(cmd, &t.curl_cfg())?;
                if o.status.success() {
                    Ok(())
                } else {
                    Err(stderr_msg(&o))
                }
            }
        }
    }

    // ---------------------------------------------------------------- scan + workers

    fn scan(&self, state: &AppState) {
        // 저장소가 지운 파일: 장부 → 묘비
        let mut gone: Vec<String> = std::mem::take(&mut *FORGET_Q.lock().unwrap());
        if RESET_REQ.swap(false, Ordering::Relaxed) {
            gone.extend(self.ledger.lock().unwrap().keys().cloned());
        }
        if !gone.is_empty() {
            let now = now_ms();
            {
                let mut led = self.ledger.lock().unwrap();
                let mut tombs = self.tombs.lock().unwrap();
                for r in &gone {
                    led.remove(r);
                    tombs.insert(r.clone(), now);
                }
            }
            let mut db = self.db.lock().unwrap();
            if let Ok(tx) = db.transaction() {
                for r in &gone {
                    let _ = tx.execute("DELETE FROM backup_files WHERE rel = ?1", params![r]);
                    let _ = tx.execute("INSERT OR REPLACE INTO backup_tombs (rel, deleted_ms) VALUES (?1, ?2)", params![r, now as i64]);
                }
                let _ = tx.commit();
            };
        }
        let ub = UNBACKED_DELETED.load(Ordering::Relaxed);
        let seen = self.unbacked_seen.swap(ub, Ordering::Relaxed);
        if ub > seen {
            let msg = format!("디스크 여유 부족: 백업 안 된 파형 파일 {}개를 삭제했습니다 (누적 {} MB)", ub - seen, UNBACKED_DELETED_BYTES.load(Ordering::Relaxed) >> 20);
            warn!("backup: {}", msg);
            state.push_event("backup_unbacked_delete", None, msg.clone());
            state.metrics.incident("backup_unbacked_delete", &msg, (ub - seen) as i64);
        }

        let p = self.policy.read().unwrap().clone();
        let active = ACTIVE.load(Ordering::Relaxed);
        let now = now_ms();
        let min_age = p.min_age_min as u64 * 60_000;
        let inflight = self.inflight.lock().unwrap().clone();
        let mut jobs: Vec<(String, String, u64)> = Vec::new();
        let mut pend = Pending::default();
        if let Ok(rd) = fs::read_dir(self.root.join("patches")) {
            for d in rd.flatten() {
                let dname = d.file_name().to_string_lossy().to_string();
                let Ok(files) = fs::read_dir(d.path()) else { continue };
                for f in files.flatten() {
                    let name = f.file_name().to_string_lossy().to_string();
                    let Some(key) = name.strip_suffix(".rec").or_else(|| name.strip_suffix(".rec.gz")) else { continue };
                    let Ok(md) = f.metadata() else { continue };
                    let size = md.len();
                    pend.local_files += 1;
                    pend.local_bytes += size;
                    let rel = format!("patches/{dname}/{name}");
                    if SAFE.get(&rel).map(|s| *s == size).unwrap_or(false) {
                        pend.safe_files += 1;
                        pend.safe_bytes += size;
                        continue;
                    }
                    // 쓰는 중인 블록이거나, 끝난 지 min_age 가 안 됐으면(늦게 오는 레코드) 아직
                    let end_ok = hour_end_ms(key).map(|e| now >= e + min_age).unwrap_or(false);
                    let mtime_ok = md.modified().ok().and_then(|m| m.elapsed().ok()).map(|e| e.as_millis() as u64 >= min_age).unwrap_or(false);
                    if !end_ok || !mtime_ok {
                        continue;
                    }
                    // 무결성 확인(봉인)이 끝난 파일만
                    match crate::patch_store::read_seal(&f.path()) {
                        None => {
                            pend.unsealed_files += 1;
                            continue;
                        }
                        Some(seal) if !seal.ok => pend.bad_sealed_files += 1,
                        Some(_) => {}
                    }
                    pend.files += 1;
                    pend.bytes += size;
                    if pend.oldest.is_empty() || key < pend.oldest.as_str() {
                        pend.oldest = key.to_string();
                    }
                    if !inflight.contains(&rel) {
                        jobs.push((key.to_string(), rel, size));
                    }
                }
            }
        }
        *self.pending.lock().unwrap() = pend;
        self.last_scan_ms.store(now, Ordering::Relaxed);
        if !active || p.paused {
            self.queue.lock().unwrap().clear();
            return;
        }
        jobs.sort(); // 오래된 시간부터 (상한에서 먼저 지워질 파일)
        jobs.truncate(20_000);
        let mut q = self.queue.lock().unwrap();
        q.clear();
        q.extend(jobs.into_iter().map(|(_, rel, size)| Job { rel, size }));
        self.cv.notify_all();
    }

    fn worker(self: &Arc<Self>, idx: u32, state: &AppState) {
        loop {
            let job = {
                let mut q = self.queue.lock().unwrap();
                loop {
                    let p = self.policy.read().unwrap();
                    if idx < p.parallel && !p.paused {
                        drop(p);
                        if let Some(j) = q.pop_front() {
                            break j;
                        }
                    } else {
                        drop(p);
                    }
                    q = self.cv.wait_timeout(q, Duration::from_secs(5)).unwrap().0;
                }
            };
            if !self.inflight.lock().unwrap().insert(job.rel.clone()) {
                continue;
            }
            self.process(&job, state);
            self.inflight.lock().unwrap().remove(&job.rel);
        }
    }

    fn process(&self, job: &Job, state: &AppState) {
        let local = self.root.join(&job.rel);
        let Ok(md) = fs::metadata(&local) else { return };
        if md.len() != job.size {
            return; // 다음 스캔에서 새 크기로
        }
        let gen = ABORT_GEN.load(Ordering::Relaxed);
        // 봉인(무결성 확인 결과)의 SHA-256 을 기준으로 올리고 원격을 검증한다 — 봉인 뒤에 로컬 파일이 바뀌었으면
        // 원격 해시가 봉인과 달라 실패한다
        let Some(seal) = crate::patch_store::read_seal(&local) else { return };
        let Some(sha) = seal_sha(&seal) else { return };
        let size = seal.size;
        if size != job.size {
            return;
        }
        let seal_local = crate::patch_store::seal_path(&local);
        let p = self.policy.read().unwrap().clone();
        let targets: Vec<Target> = self.targets.read().unwrap().iter().filter(|t| t.enabled).cloned().collect();
        let need = self.need_copies();
        let mut have: HashSet<String> = self
            .ledger
            .lock()
            .unwrap()
            .get(&job.rel)
            .map(|v| v.iter().filter(|c| c.size == size && c.sha == sha).map(|c| c.target.clone()).collect())
            .unwrap_or_default();
        have.retain(|id| targets.iter().any(|t| &t.id == id));
        let remote = {
            let tombs = self.tombs.lock().unwrap();
            if tombs.contains_key(&job.rel) {
                // 같은 이름을 예전에 올리고 로컬에서 지웠다: 덮어쓰지 않도록 다른 이름으로
                let (stem, ext) = job.rel.rsplit_once(".rec").map(|(a, b)| (a.to_string(), format!(".rec{b}"))).unwrap_or((job.rel.clone(), String::new()));
                format!("{stem}.late-{}{ext}", now_ms())
            } else {
                job.rel.clone()
            }
        };
        for t in &targets {
            if have.len() >= need || ABORT_GEN.load(Ordering::Relaxed) != gen {
                break;
            }
            if have.contains(&t.id) {
                continue;
            }
            {
                let st = self.stats.lock().unwrap();
                if let Some(u) = st.get(&t.id).and_then(|s| s.down_until) {
                    if Instant::now() < u {
                        continue; // 최근 실패: 다음 순위로
                    }
                }
            }
            self.stats.lock().unwrap().entry(t.id.clone()).or_default().busy += 1;
            let t0 = Instant::now();
            // 데이터 파일 → 봉인 파일(.sum) 순서. 봉인까지 올라가야 그 대상의 사본으로 친다
            let r = self.upload(t, &p, &local, &remote, size, &sha, false).and_then(|_| {
                let remote_sum = {
                    let stem = remote.strip_suffix(".rec.gz").or_else(|| remote.strip_suffix(".rec")).unwrap_or(&remote);
                    format!("{stem}.sum")
                };
                let (ssha, ssize) = sha_file(&seal_local).map_err(|e| format!("봉인 파일 읽기 실패: {e}"))?;
                self.upload(t, &p, &seal_local, &remote_sum, ssize, &ssha, false).map_err(|e| format!("봉인 파일(.sum) 올리기 실패: {e}"))
            });
            let ms = t0.elapsed().as_millis() as u64;
            let mut st = self.stats.lock().unwrap();
            let s = st.entry(t.id.clone()).or_default();
            s.busy = s.busy.saturating_sub(1);
            match r {
                Ok(()) => {
                    s.ok_files += 1;
                    s.ok_bytes += size;
                    s.last_ok_ms = now_ms();
                    s.fail_streak = 0;
                    s.down_until = None;
                    s.avg_ms = if s.avg_ms == 0 { ms } else { (s.avg_ms * 7 + ms) / 8 };
                    drop(st);
                    have.insert(t.id.clone());
                    self.ledger.lock().unwrap().entry(job.rel.clone()).or_default().push(Copy { target: t.id.clone(), size, sha });
                    if let Ok(db) = self.db.lock() {
                        let _ = db.execute(
                            "INSERT OR REPLACE INTO backup_files (rel, target, size, sha, remote, done_ms) VALUES (?1,?2,?3,?4,?5,?6)",
                            params![job.rel, t.id, size as i64, sha.to_vec(), remote, now_ms() as i64],
                        );
                        let _ = db.execute(
                            "INSERT OR REPLACE INTO backup_catalog (target, rel, hour, size, sha, done_ms, src, remote) VALUES (?1,?2,?3,?4,?5,?6,'upload',?7)",
                            params![t.id, job.rel, hour_of(&job.rel), size as i64, sha.to_vec(), now_ms() as i64, remote],
                        );
                        let _ = db.execute(
                            "INSERT INTO backup_daily (day, target, files, bytes) VALUES (?1,?2,1,?3) ON CONFLICT(day, target) DO UPDATE SET files = files + 1, bytes = bytes + ?3",
                            params![day_key(now_ms()), t.id, size as i64],
                        );
                    }
                    self.logit(&t.name, &remote, size, ms, true, format!("검증 완료 ({}){}", if p.verify == "sha256" { format!("SHA-256 {}…", &hex(&sha)[..12]) } else { "크기".into() },
                        if seal.ok { format!(" · 봉인 CRC-32 {}", seal.crc32) } else { format!(" · 주의: 항목 CRC 오류 {}건", seal.bad_entries) }));
                }
                Err(_) if ABORT_GEN.load(Ordering::Relaxed) != gen => {
                    // 사용자가 중단했다: 대상 장애가 아니다 (올리다 만 원격 파일은 재개 때 덮어쓴다)
                    drop(st);
                    self.logit(&t.name, &remote, size, ms, false, "사용자 중단".into());
                }
                Err(e) => {
                    s.fail += 1;
                    s.fail_streak += 1;
                    s.last_err = e.clone();
                    s.last_err_ms = now_ms();
                    let back = (30u64 << s.fail_streak.min(4)).min(300);
                    s.down_until = Some(Instant::now() + Duration::from_secs(back));
                    let first = s.fail_streak == 1;
                    drop(st);
                    self.logit(&t.name, &remote, size, ms, false, e.clone());
                    if first {
                        warn!("backup: {} → {} failed: {}", job.rel, t.name, e);
                        state.push_event("backup_fail", None, format!("백업 대상 '{}' 실패: {} — {}초 동안 다음 순위로 넘깁니다", t.name, e, back));
                    }
                }
            }
        }
        if have.len() >= need {
            // 올리는 동안 파일이 커졌으면 SAFE 로 치지 않는다 (다음 스캔에서 다시)
            let now_size = fs::metadata(&local).map(|m| m.len()).unwrap_or(0);
            if now_size != size {
                return;
            }
            SAFE.insert(job.rel.clone(), size);
            if p.delete_mode == "immediate" && fs::remove_file(&local).is_ok() {
                let _ = fs::remove_file(&seal_local);
                let cur = crate::patch_store::STORE_BYTES.load(Ordering::Relaxed);
                crate::patch_store::STORE_BYTES.fetch_sub(size.min(cur), Ordering::Relaxed);
                forgotten(job.rel.clone());
            }
        }
    }
}

fn check(n: u64, size: u64, h: &[u8; 32], sha: &[u8; 32]) -> Result<(), String> {
    if n != size {
        return Err(format!("크기 불일치: 원격 {n} ≠ 로컬 {size}"));
    }
    if h != sha {
        return Err(format!("SHA-256 불일치: 원격 {}… ≠ 로컬 {}…", &hex(h)[..12], &hex(sha)[..12]));
    }
    Ok(())
}

fn hostname() -> String {
    fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()).unwrap_or_default()
}

/// 스캐너(30 s 또는 설정 변경 시) + 작업 스레드 8개 (정책 `parallel` 개만 일함)
pub fn start(state: Arc<AppState>) {
    let b = state.backup.clone();
    {
        let (b, st) = (b.clone(), state.clone());
        std::thread::Builder::new()
            .name("backup-scan".into())
            .spawn(move || {
                let mut last = Instant::now() - Duration::from_secs(3600);
                loop {
                    if b.scan_now.swap(false, Ordering::Relaxed) || last.elapsed() >= Duration::from_secs(30) {
                        last = Instant::now();
                        b.scan(&st);
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            })
            .expect("backup scan thread");
    }
    for i in 0..8u32 {
        let (b, st) = (b.clone(), state.clone());
        std::thread::Builder::new()
            .name(format!("backup-{i}"))
            .spawn(move || b.worker(i, &st))
            .expect("backup worker thread");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_helpers() {
        assert_eq!(hour_of("patches/00076509/20260923-07.rec"), "20260923-07");
        assert_eq!(hour_of("patches/00076509/20260923-07.rec.gz"), "20260923-07");
        assert_eq!(parse_list_line("-rw-r--r--   1 user  users  3582000 Sep 24 19:45 20260923-07.rec"), Some(("20260923-07.rec".into(), Some(3582000), false)));
        assert_eq!(parse_list_line("drwxrwxrwx   1 user  users        0 Sep 24 19:45 00076509"), Some(("00076509".into(), Some(0), true)));
        assert_eq!(parse_list_line("drwxr-xr-x 2 u g 4096 Sep 24 19:45 ."), None);
        assert_eq!(parse_list_line("total 12"), None);
    }

    use super::*;

    #[test]
    fn hour_end() {
        // 2026-09-21 15:00 UTC → 16:00 UTC
        assert_eq!(hour_end_ms("20260921-15"), Some(1_790_006_400_000));
        assert_eq!(crate::patch_store::hour_key(1_790_006_400_000 - 1), "20260921-15");
    }

    #[test]
    fn urls() {
        let mut t = Target { kind: "sftp".into(), host: "nas.local".into(), path: "/data/bio".into(), ..Default::default() };
        assert_eq!(t.url("patches/00000001/20260921-15.rec"), "sftp://nas.local/data/bio/patches/00000001/20260921-15.rec");
        t.path = "~/bio".into();
        assert_eq!(t.url("a b.rec"), "sftp://nas.local/~/bio/a%20b.rec");
        t.kind = "ftp".into();
        t.port = 2121;
        t.path = "backup".into();
        assert_eq!(t.url("x.rec"), "ftp://nas.local:2121/backup/x.rec");
        t.kind = "ftps".into();
        assert_eq!(t.url("x.rec"), "ftp://nas.local:2121/backup/x.rec");
    }

    #[test]
    fn local_nas_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bk-test-{}", now_ms()));
        let store = dir.join("store");
        let nas = dir.join("nas");
        fs::create_dir_all(store.join("patches/00000001")).unwrap();
        fs::create_dir_all(&nas).unwrap();
        let db = dir.join("t.db");
        let b = Backup::open(db.to_str().unwrap(), store.to_str().unwrap());
        let f = store.join("patches/00000001/20200101-00.rec");
        fs::write(&f, b"hello world").unwrap();
        let t = Target { id: "n".into(), kind: "nas".into(), path: nas.display().to_string(), insecure: true, enabled: true, ..Default::default() };
        let (sha, size) = sha_file(&f).unwrap();
        let p = Policy::default();
        b.upload(&t, &p, &f, "patches/00000001/20200101-00.rec", size, &sha, false).unwrap();
        assert_eq!(fs::read(nas.join("patches/00000001/20200101-00.rec")).unwrap(), b"hello world");
        // 크기 다르면 실패
        assert!(b.upload(&t, &p, &f, "patches/00000001/x.rec", size + 1, &sha, false).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
