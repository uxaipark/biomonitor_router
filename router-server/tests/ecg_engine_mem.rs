//! 엔진 채널 하나의 메모리 비용(RSS 증가분 / 채널 수) — 프리셋별. ROUTER_ECG_LIB 없으면 SKIPPED.
use router_core::ecg_engine::*;
fn rss_kb() -> u64 { std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse().ok())).unwrap_or(0) }
#[test]
fn per_channel_memory() {
    let path = std::env::var("ROUTER_ECG_LIB").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../data/engine/libecg.so").to_string());
    if !std::path::Path::new(&path).exists() { eprintln!("SKIPPED"); return; }
    let eng = Engine::load(&path).expect("load");
    for (name, preset) in [("patch", ECG_PRESET_PATCH), ("clinical", ECG_PRESET_CLINICAL)] {
        let n = 400;
        let before = rss_kb();
        let mut v: Vec<Channel> = (0..n).map(|_| eng.channel(250.0, preset, "").unwrap()).collect();
        // 몇 초 분량을 밀어 넣어 지연 할당까지 포함
        let buf = vec![0.1f32; 50];
        let mut ev = Vec::new();
        for _ in 0..50 { for c in v.iter_mut() { c.push(&buf); c.poll(&mut ev); ev.clear(); } }
        let after = rss_kb();
        eprintln!("preset {name}: {} channels → +{} MB → {:.0} KB/channel", n, (after - before) / 1024, (after - before) as f64 / n as f64);
        drop(v);
    }
}
