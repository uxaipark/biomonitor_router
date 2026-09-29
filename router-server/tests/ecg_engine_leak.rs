//! 엔진이 정상 상태에서 메모리를 늘리는지: 채널 400개에 합성 신호(60 bpm + 잡음 + 가끔 유실 gap)를 300초 분량 밀어 넣으며 RSS 를 60초마다 찍는다.
use router_core::ecg_engine::*;
fn rss_kb() -> u64 { std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse().ok())).unwrap_or(0) }
#[test]
fn steady_state_memory() {
    let path = std::env::var("ROUTER_ECG_LIB").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../data/engine/libecg.so").to_string());
    if !std::path::Path::new(&path).exists() { eprintln!("SKIPPED"); return; }
    let eng = Engine::load(&path).expect("load");
    let preset = if std::env::var("PRESET").as_deref() == Ok("clinical") { ECG_PRESET_CLINICAL } else { ECG_PRESET_PATCH };
    let n = 400usize; let fs = 250usize; let secs = 300usize;
    let mut v: Vec<Channel> = (0..n).map(|_| eng.channel(fs as f64, preset, "").unwrap()).collect();
    let mut ev = Vec::new(); let mut buf = vec![0f32; 50]; let (mut beats, mut events) = (0u64, 0u64);
    let base = rss_kb();
    eprintln!("start RSS {} MB ({} channels)", base / 1024, n);
    let mut t = 0usize;
    while t < secs * fs {
        for (i, x) in buf.iter_mut().enumerate() { let k = (t + i) % fs; let ph = ((t + i) as f32) * 0.013; *x = if k < 10 { 1.2 * (1.0 - ((k as f32 - 5.0).abs() / 5.0)) } else { 0.05 * (ph * 2.0).sin() } + 0.02 * (ph * 37.0).sin(); }
        for (ci, c) in v.iter_mut().enumerate() {
            if (t / 50 + ci) % 397 == 0 { c.gap(50); }
            c.push(&buf); ev.clear(); c.poll(&mut ev);
            for e in &ev { if e.kind == EV_BEAT { beats += 1 } events += 1 }
            if t % (fs * 5) == 0 { let _ = c.status(); }
        }
        t += 50;
        if t % (60 * fs) == 0 { eprintln!("t={:>4}s RSS {} MB (+{} MB)  beats {} events {}", t / fs, rss_kb() / 1024, (rss_kb().saturating_sub(base)) / 1024, beats, events); }
    }
}
