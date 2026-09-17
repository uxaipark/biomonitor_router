use crate::protocol::EcgPacket;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

/// 파형 파일 저장소.
///
/// 모든 채널의 파형이 라우터를 통과하므로 저장 주체도 라우터가 맡는다
/// (고속 시계열 쓰기는 SQLite 에 부적합 — DB 는 메타데이터 전용).
///
/// 보관 정책: 파형은 **8시간 단위 세그먼트 파일**로 저장·보관한다.
///  - 닫힌(과거 블록) 세그먼트는 백그라운드에서 gzip 압축 (.bin → .bin.gz, ~1.7×)
///    — 5초당 1파일씩만 처리해 8시간 경계에서 작업이 몰리지 않는다.
///  - 총 용량이 상한(ROUTER_WAVE_MAX_GB, 기본 200GB)을 넘으면 **오래된 압축
///    파일부터** 삭제해 95% 수위로 유지한다 (활성 세그먼트는 보호).
///  - 조회(read_range/info)는 .bin / .bin.gz 를 투명하게 처리한다.
///
/// 배치: waves/<channel_id>/<epoch_8h_block>.bin[.gz]
/// 레코드(LE): [ts_ms u64][seq u64][sample_rate u16][n u16][samples i16 × n]
///   (샘플은 ×1000 정수 양자화 — mV 해상도 유지, NDJSON 대비 1/4 크기)
const SEG_MS_DEFAULT: u64 = 8 * 3_600_000;

fn seg_of(ts_ms: u64, seg_ms: u64) -> u64 {
    ts_ms / seg_ms
}

/// 채널 ID 를 파일 경로에 안전하게 (영숫자/대시/언더스코어만 허용)
fn safe_id(id: &str) -> Option<String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Some(id.to_string())
    } else {
        None
    }
}

struct OpenSeg {
    seg: u64,
    w: BufWriter<File>,
    /// 마지막 기록 시각 — 유휴 핸들 축출 판단용
    last_write: std::time::Instant,
}

/// 이 시간 동안 기록이 없는 채널의 파일 핸들은 닫는다 (FD/버퍼 누수 방지 —
/// 퇴원/교체/병원전환으로 사라진 채널의 핸들이 재시작 전까지 쌓이는 것을 차단).
/// 다시 패킷이 오면 append 모드로 같은 세그먼트 파일을 그대로 이어 쓴다.
const IDLE_EVICT: Duration = Duration::from_secs(300);

/// 저장된 파형 파일 전체 용량 (30초 주기 집계, /api/stats 데이터 I/O 카드 표기용)
pub static WAVE_STORE_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 저장소 스캔 결과: 파일 목록 (seg 블록 번호 / 압축 여부 / 크기 / 경로)
struct StoreFile {
    ch: String,
    seg: u64,
    is_gz: bool,
    size: u64,
    path: PathBuf,
}

/// waves/ 하위 전체 파일 스캔 (총 용량 집계 + 압축/수위조절 후보 수집)
fn scan_store(base: &Path) -> (u64, Vec<StoreFile>) {
    let mut total = 0u64;
    let mut files = Vec::new();
    if let Ok(chs) = fs::read_dir(base) {
        for ch in chs.flatten() {
            let ch_name = ch.file_name().to_string_lossy().to_string();
            if let Ok(entries) = fs::read_dir(ch.path()) {
                for f in entries.flatten() {
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    total += size;
                    let name = f.file_name().to_string_lossy().to_string();
                    let (stem, is_gz) = if let Some(s) = name.strip_suffix(".bin.gz") {
                        (s, true)
                    } else if let Some(s) = name.strip_suffix(".bin") {
                        (s, false)
                    } else {
                        continue;
                    };
                    if let Ok(seg) = stem.parse::<u64>() {
                        files.push(StoreFile {
                            ch: ch_name.clone(), seg, is_gz, size, path: f.path(),
                        });
                    }
                }
            }
        }
    }
    (total, files)
}

/// 닫힌 세그먼트 파일 하나를 gzip 압축 (blocking — spawn_blocking 에서 호출).
/// 임시 파일에 쓴 뒤 rename, 성공 시 원본 삭제 → 조회는 .bin/.bin.gz 둘 다 지원.
fn compress_file(path: &Path) -> std::io::Result<()> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    let data = fs::read(path)?;
    let gz_path = path.with_extension("bin.gz");
    let tmp = path.with_extension("bin.gz.tmp");
    {
        let mut enc = GzEncoder::new(fs::File::create(&tmp)?, Compression::new(6));
        enc.write_all(&data)?;
        enc.finish()?.sync_all()?;
    }
    fs::rename(&tmp, &gz_path)?;
    fs::remove_file(path)?;
    Ok(())
}

/// 200GB(설정값) 수위 조절: 오래된 **압축 파일부터** 삭제, 부족하면 오래된 원본까지.
/// 활성(현재 블록/열린 핸들) 파일은 건드리지 않는다. 목표는 상한의 95% (히스테리시스).
fn enforce_cap(
    files: &mut Vec<StoreFile>,
    total: u64,
    cap: u64,
    cur_seg: u64,
    open: &HashMap<String, OpenSeg>,
) -> (u64, usize) {
    if total <= cap {
        return (total, 0);
    }
    let target = cap / 20 * 19; // 95%
    // 삭제 순서: (원본보다 압축본 먼저) → 오래된 seg 먼저
    files.sort_by_key(|f| (!f.is_gz, f.seg));
    let open_pairs: std::collections::HashSet<(&str, u64)> =
        open.iter().map(|(k, v)| (k.as_str(), v.seg)).collect();
    let mut freed = 0usize;
    let mut now_total = total;
    for f in files.iter() {
        if now_total <= target {
            break;
        }
        // 현재 블록/열린 세그먼트는 보호
        if f.seg >= cur_seg || (!f.is_gz && open_pairs.contains(&(f.ch.as_str(), f.seg))) {
            continue;
        }
        if fs::remove_file(&f.path).is_ok() {
            now_total = now_total.saturating_sub(f.size);
            freed += 1;
        }
    }
    (now_total, freed)
}

/// 파형 기록 태스크. ingest 핫패스를 막지 않도록 mpsc 로 받아 기록한다.
/// reset_rx 신호가 오면 열린 핸들을 전부 닫고 저장 파일을 삭제한다 (저장소 리셋).
pub async fn run_writer(
    dir: String,
    segment_hours: u64,
    max_gb: u64,
    mut rx: mpsc::Receiver<EcgPacket>,
    mut reset_rx: tokio::sync::watch::Receiver<u64>,
) {
    let max_bytes = max_gb.saturating_mul(1024 * 1024 * 1024);
    let seg_ms = if segment_hours == 0 { SEG_MS_DEFAULT } else { segment_hours * 3_600_000 };
    let base = PathBuf::from(&dir);
    let _ = fs::create_dir_all(&base);
    info!(
        "wave store: dir={} segment={}h 상한={}GB (닫힌 세그먼트 gzip, 초과 시 오래된 것부터 삭제)",
        dir, seg_ms / 3_600_000, max_gb
    );

    let mut open: HashMap<String, OpenSeg> = HashMap::new();
    let mut flush_tick = tokio::time::interval(Duration::from_secs(5));
    let mut scan_countdown = 0u8; // 6틱(30초)마다 저장소 용량 집계
    // 닫힌 세그먼트 압축: 후보 큐 + 진행 중 작업 (한 번에 1개 — 몰림 방지)
    let mut compress_queue: std::collections::VecDeque<PathBuf> = std::collections::VecDeque::new();
    let mut compress_job: Option<tokio::task::JoinHandle<()>> = None;

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                let Some(pkt) = maybe else { return };
                let Some(id) = safe_id(&pkt.channel_id) else { continue };
                let seg = seg_of(pkt.ts_ms, seg_ms);
                let need_open = match open.get(&id) {
                    Some(s) => s.seg != seg,
                    None => true,
                };
                if need_open {
                    // 8시간 분량이 채워짐 → 이전 파일을 닫고 다음 세그먼트 파일 생성
                    if let Some(mut s) = open.remove(&id) {
                        let _ = s.w.flush();
                    }
                    let ch_dir = base.join(&id);
                    let _ = fs::create_dir_all(&ch_dir);
                    match OpenOptions::new().create(true).append(true)
                        .open(ch_dir.join(format!("{}.bin", seg)))
                    {
                        Ok(f) => {
                            open.insert(id.clone(), OpenSeg {
                                seg,
                                w: BufWriter::new(f),
                                last_write: std::time::Instant::now(),
                            });
                        }
                        Err(e) => { warn!("wave open failed {}: {}", id, e); continue; }
                    }
                }
                if let Some(s) = open.get_mut(&id) {
                    s.last_write = std::time::Instant::now();
                    let mut rec = Vec::with_capacity(20 + pkt.samples.len() * 2);
                    rec.extend_from_slice(&pkt.ts_ms.to_le_bytes());
                    rec.extend_from_slice(&pkt.seq.to_le_bytes());
                    rec.extend_from_slice(&(pkt.sample_rate as u16).to_le_bytes());
                    rec.extend_from_slice(&(pkt.samples.len() as u16).to_le_bytes());
                    for v in &pkt.samples {
                        rec.extend_from_slice(
                            &(((v * 1000.0).clamp(-32768.0, 32767.0)) as i16).to_le_bytes());
                    }
                    let _ = s.w.write_all(&rec);
                }
            }
            _ = flush_tick.tick() => {
                for s in open.values_mut() {
                    let _ = s.w.flush();
                }
                // 유휴 채널 핸들 축출 (flush 는 위에서 이미 완료)
                let before = open.len();
                open.retain(|_, s| s.last_write.elapsed() < IDLE_EVICT);
                let evicted = before - open.len();
                if evicted > 0 {
                    info!("wave store: 유휴 채널 핸들 {}개 닫음 (남은 {})", evicted, open.len());
                }
                // 30초마다: 용량 집계 + 수위 조절(200GB) + 압축 후보 수집
                if scan_countdown == 0 {
                    scan_countdown = 6;
                    let (total, mut files) = scan_store(&base);
                    let cur_seg = seg_of(crate::protocol::now_ms(), seg_ms);
                    let (after, freed) =
                        enforce_cap(&mut files, total, max_bytes, cur_seg, &open);
                    if freed > 0 {
                        warn!(
                            "wave store 수위 조절: 오래된 파일 {}개 삭제 ({:.1} → {:.1} GB, 상한 {} GB)",
                            freed,
                            total as f64 / 1e9 * 0.931,
                            after as f64 / 1e9 * 0.931,
                            max_gb
                        );
                    }
                    WAVE_STORE_BYTES.store(after, std::sync::atomic::Ordering::Relaxed);
                    // 압축 후보: 과거 블록의 원본(.bin), 열린 핸들 제외, 오래된 것부터.
                    // 큐가 빈 뒤에만 재수집 (같은 파일 중복 적재 방지)
                    if compress_queue.is_empty() {
                        let open_pairs: std::collections::HashSet<(&str, u64)> =
                            open.iter().map(|(k, v)| (k.as_str(), v.seg)).collect();
                        let mut cands: Vec<&StoreFile> = files
                            .iter()
                            .filter(|f| {
                                !f.is_gz
                                    && f.seg < cur_seg
                                    && !open_pairs.contains(&(f.ch.as_str(), f.seg))
                            })
                            .collect();
                        cands.sort_by_key(|f| f.seg);
                        for c in cands {
                            compress_queue.push_back(c.path.clone());
                        }
                        if !compress_queue.is_empty() {
                            info!(
                                "wave store: 닫힌 세그먼트 압축 대기 {}건 (5초당 1개씩 분산 처리)",
                                compress_queue.len()
                            );
                        }
                    }
                }
                scan_countdown -= 1;
                // 압축 실행: 이전 작업이 끝났을 때만 다음 1건 (CPU/IO 몰림 방지)
                if compress_job.as_ref().map(|j| j.is_finished()).unwrap_or(true) {
                    compress_job = None;
                    while let Some(p) = compress_queue.pop_front() {
                        if !p.exists() {
                            continue; // 수위 조절로 이미 삭제됨
                        }
                        compress_job = Some(tokio::task::spawn_blocking(move || {
                            if let Err(e) = compress_file(&p) {
                                warn!("wave 압축 실패 {:?}: {}", p, e);
                            }
                        }));
                        break;
                    }
                }
            }
            // 저장소 리셋: 핸들을 전부 닫은 뒤(쓰기 유실/좀비 inode 방지) 파일 삭제.
            // 삭제 후 들어오는 패킷은 새 파일이 자동 생성되어 이어진다.
            changed = reset_rx.changed() => {
                if changed.is_err() { continue }
                let handles = open.len();
                open.clear(); // BufWriter drop → flush+close
                compress_queue.clear();
                let mut removed = 0usize;
                if let Ok(entries) = fs::read_dir(&base) {
                    for e in entries.flatten() {
                        let p = e.path();
                        let ok = if p.is_dir() {
                            fs::remove_dir_all(&p).is_ok()
                        } else {
                            fs::remove_file(&p).is_ok()
                        };
                        if ok { removed += 1 }
                    }
                }
                WAVE_STORE_BYTES.store(0, std::sync::atomic::Ordering::Relaxed);
                info!("wave store 리셋: 핸들 {}개 닫고 채널 디렉토리 {}개 삭제", handles, removed);
            }
        }
    }
}

/// 저장된 세그먼트 하나의 레코드들을 디코드
fn decode_file(path: &Path, from_ms: u64, to_ms: u64, out: &mut Vec<(u64, u32, Vec<f32>)>) {
    let Ok(mut f) = File::open(path) else { return };
    let mut buf = Vec::new();
    let is_gz = path.extension().map(|e| e == "gz").unwrap_or(false);
    if is_gz {
        // 닫힌 세그먼트는 gzip 압축 보관 — 조회 시 투명하게 해제
        let mut dec = flate2::read::GzDecoder::new(f);
        if dec.read_to_end(&mut buf).is_err() {
            return;
        }
    } else if f.read_to_end(&mut buf).is_err() {
        return;
    }
    let mut i = 0usize;
    while i + 20 <= buf.len() {
        let ts = u64::from_le_bytes(buf[i..i + 8].try_into().unwrap());
        let sr = u16::from_le_bytes(buf[i + 16..i + 18].try_into().unwrap()) as u32;
        let n = u16::from_le_bytes(buf[i + 18..i + 20].try_into().unwrap()) as usize;
        let end = i + 20 + n * 2;
        if end > buf.len() {
            break; // 마지막 레코드가 잘린 경우 (flush 경계)
        }
        if ts >= from_ms && ts <= to_ms {
            let mut samples = Vec::with_capacity(n);
            for k in 0..n {
                let v = i16::from_le_bytes(buf[i + 20 + k * 2..i + 22 + k * 2].try_into().unwrap());
                samples.push(v as f32 / 1000.0);
            }
            out.push((ts, sr, samples));
        }
        i = end;
    }
}

fn seg_ms_of_dir() -> u64 {
    // 현재는 고정 8시간 (config 의 wave_segment_hours 와 동일 기본값)
    SEG_MS_DEFAULT
}

/// 채널의 저장 구간(ms 범위)과 용량 — 리포트 뷰어의 범위 표시용
pub fn info(dir: &str, channel_id: &str) -> Option<(u64, u64, u64)> {
    let id = safe_id(channel_id)?;
    let seg_ms = seg_ms_of_dir();
    let ch_dir = Path::new(dir).join(id);
    let entries = fs::read_dir(&ch_dir).ok()?;
    let mut segs: Vec<u64> = Vec::new();
    let mut bytes = 0u64;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let stem = name.strip_suffix(".bin.gz").or_else(|| name.strip_suffix(".bin"));
        if let Some(h) = stem.and_then(|s| s.parse::<u64>().ok()) {
            segs.push(h);
            bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    if segs.is_empty() {
        return None;
    }
    segs.sort_unstable();
    let from = segs[0] * seg_ms;
    let to = (segs[segs.len() - 1] + 1) * seg_ms;
    Some((from, to.min(crate::protocol::now_ms()), bytes))
}

/// 범위 내 레코드 읽기 (ts 오름차순)
pub fn read_range(dir: &str, channel_id: &str, from_ms: u64, to_ms: u64)
    -> Vec<(u64, u32, Vec<f32>)>
{
    let Some(id) = safe_id(channel_id) else { return Vec::new() };
    let seg_ms = seg_ms_of_dir();
    let ch_dir = Path::new(dir).join(id);
    let mut out = Vec::new();
    for s in seg_of(from_ms, seg_ms)..=seg_of(to_ms, seg_ms) {
        let p = ch_dir.join(format!("{}.bin", s));
        if p.exists() {
            decode_file(&p, from_ms, to_ms, &mut out);
        } else {
            // 압축 보관본 폴백
            let pgz = ch_dir.join(format!("{}.bin.gz", s));
            if pgz.exists() {
                decode_file(&pgz, from_ms, to_ms, &mut out);
            }
        }
    }
    out.sort_by_key(|r| r.0);
    out
}

/// 구간 개요: 범위를 buckets 개 구간으로 나눠 (t, min, max) — 장구간 개요 스트립용
pub fn overview(dir: &str, channel_id: &str, from_ms: u64, to_ms: u64, buckets: usize)
    -> Vec<(u64, f32, f32)>
{
    let recs = read_range(dir, channel_id, from_ms, to_ms);
    if recs.is_empty() || to_ms <= from_ms {
        return Vec::new();
    }
    let n = buckets.clamp(10, 2000);
    let span = to_ms - from_ms;
    let mut mm: Vec<Option<(f32, f32)>> = vec![None; n];
    for (ts, sr, samples) in &recs {
        for (k, v) in samples.iter().enumerate() {
            let t = ts + (k as u64 * 1000) / (*sr as u64).max(1);
            if t < from_ms || t > to_ms {
                continue;
            }
            let b = (((t - from_ms) as u128 * n as u128) / (span as u128 + 1)) as usize;
            let e = mm[b.min(n - 1)].get_or_insert((*v, *v));
            e.0 = e.0.min(*v);
            e.1 = e.1.max(*v);
        }
    }
    mm.iter().enumerate()
        .filter_map(|(i, v)| v.map(|(lo, hi)| (from_ms + (i as u64 * span) / n as u64, lo, hi)))
        .collect()
}
