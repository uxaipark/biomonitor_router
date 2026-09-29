//! 채널 생성·해제를 반복할 때(환자 교대) 메모리가 남는지: 600채널 × 20초 밀어 넣고 전부 해제, 6회 반복하며 RSS 를 본다.
use router_core::ecg_engine::*;
fn rss_kb() -> u64 { std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse().ok())).unwrap_or(0) }
#[test]
fn create_destroy_churn() {
    let path = std::env::var("ROUTER_ECG_LIB").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../data/engine/libecg.so").to_string());
    if !std::path::Path::new(&path).exists() { eprintln!("SKIPPED"); return; }
    let eng = Engine::load(&path).expect("load");
    let buf: Vec<f32> = (0..50).map(|i| if i < 10 { 1.0 } else { 0.02 }).collect();
    let mut ev = Vec::new();
    let base = rss_kb();
    for cycle in 0..6 {
        let mut v: Vec<Channel> = (0..600).map(|_| eng.channel(250.0, ECG_PRESET_PATCH, "").unwrap()).collect();
        for _ in 0..100 { for c in v.iter_mut() { c.push(&buf); ev.clear(); c.poll(&mut ev); } }
        let with = rss_kb();
        drop(v);
        unsafe { libc::malloc_trim(0); }
        eprintln!("cycle {cycle}: with channels +{} MB, after drop+trim +{} MB (vs start)", (with - base) / 1024, (rss_kb().saturating_sub(base)) / 1024);
    }
}
