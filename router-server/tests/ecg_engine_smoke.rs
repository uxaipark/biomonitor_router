//! libecg.so 가 있으면(ROUTER_ECG_LIB 또는 data/engine/libecg.so) 로더·채널·이벤트 경로를 실제로 돌려 본다. 없으면 SKIPPED.
use router_core::ecg_engine::*;

#[test]
fn load_and_run_synthetic() {
    let path = std::env::var("ROUTER_ECG_LIB").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../data/engine/libecg.so").to_string());
    if !std::path::Path::new(&path).exists() {
        eprintln!("SKIPPED: no engine at {path}");
        return;
    }
    let eng = Engine::load(&path).expect("load");
    eprintln!("engine {} abi {:?} stages {}", eng.id, eng.abi, eng.stages.len());
    assert!(!eng.stages.is_empty());
    let mut ch = eng.channel(250.0, ECG_PRESET_PATCH, "").expect("channel");
    eprintln!("channel stages: {}", ch.stages());
    // 60 bpm 비슷한 합성 신호: 1초마다 짧은 삼각 R파 + 작은 잡음, 200 ms 번들로 밀어 넣기
    let fs = 250usize;
    let mut ev = Vec::new();
    let mut t = 0usize;
    for _bundle in 0..(60 * 5) {
        let mut buf = vec![0f32; 50];
        for (i, v) in buf.iter_mut().enumerate() {
            let k = (t + i) % fs;
            *v = if k < 10 { 1.2 * (1.0 - ((k as f32 - 5.0).abs() / 5.0)) } else { 0.0 } + 0.02 * (((t + i) as f32) * 0.7).sin();
        }
        t += 50;
        assert_eq!(ch.push(&buf), 0);
        ch.poll(&mut ev);
    }
    ch.gap(250); // 1 s 유실 선언
    ch.poll(&mut ev);
    let st = ch.status();
    let beats = ev.iter().filter(|e| e.kind == EV_BEAT).count();
    eprintln!("events {} beats {} status quality {} state {} samples {} q {:.2}", ev.len(), beats, st.quality, st.state, st.samples, st.quality_score);
    assert!(beats > 30, "expected beats from a 60 bpm synthetic signal, got {beats}");
    assert!(!ch.poisoned());
}
