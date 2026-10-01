//! 에뮬레이터 정답지(리듬 에피소드·전극 탈락·기저 리듬)를 파형 저장소와 같은 방식으로 보관한다.
//!
//! 배치: `<저장소>/truth/<YYYYMMDD-HH>.jsonl` — 파형 파일과 같은 UTC 시간 키, 한 시간에 파일 하나(전체 환자).
//! 줄: {"t":"meta",...} 1줄 + {"t":"ep","p":패치,"k":"rhythm_episode|lead_off","v":값,"s":시작ms,"e":끝ms|null}
//!     + {"t":"base","p":패치,"v":기저리듬}. 에피소드는 그 시간과 겹치는 것을 모두 담는다(여러 시간에 걸치면 각 파일에 중복).
//! 생명주기: 진행 중인 시간은 1분마다 다시 쓰고, 시간이 끝나고 30분 뒤(늦게 끝나는 에피소드 반영) `<이름>.sum` 으로 봉인해 더 바꾸지 않는다.
//! 봉인된 파일은 파형처럼 백업 대상(`truth/<이름>`)이 되고, 백업이 끝난 뒤 30일이 지나면 로컬에서 지운다. 지난 날 리포트는
//! 로컬 → 백업 복원 → 에뮬레이터 순서로 읽는다.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const DIR: &str = "truth";
pub const SEAL_GRACE_MS: u64 = 30 * 60_000;
pub const KEEP_DAYS: u64 = 30;

pub fn dir(root: &Path) -> PathBuf { root.join(DIR) }
pub fn file_of(root: &Path, key: &str) -> PathBuf { dir(root).join(format!("{key}.jsonl")) }
pub fn rel_of(key: &str) -> String { format!("{DIR}/{key}.jsonl") }

/// 한 정답 에피소드 (패치, 종류, 값, 시작, 끝)
pub type Ep = (u32, String, String, u64, Option<u64>);

/// 시간 파일 쓰기 (봉인된 파일은 건드리지 않음). eps 는 그 시간과 겹치는 것만 넘긴다.
pub fn write_hour(root: &Path, key: &str, eps: &[Ep], bases: &HashMap<u32, String>, emulator: &str) -> std::io::Result<bool> {
    let f = file_of(root, key);
    if crate::patch_store::read_seal(&f).is_some() { return Ok(false); }
    fs::create_dir_all(dir(root))?;
    let mut out = String::new();
    out.push_str(&serde_json::json!({ "t": "meta", "hour": key, "source": "emulator /api/v1/labels", "emulator": emulator, "written_ms": crate::protocol::now_ms(), "format": 1 }).to_string());
    out.push('\n');
    let mut eps: Vec<&Ep> = eps.iter().collect();
    eps.sort_by(|a, b| (a.0, a.3).cmp(&(b.0, b.3)));
    let mut pats: Vec<u32> = Vec::new();
    for (p, k, v, s, e) in eps {
        out.push_str(&serde_json::json!({ "t": "ep", "p": p, "k": k, "v": v, "s": s, "e": e }).to_string());
        out.push('\n');
        pats.push(*p);
    }
    let mut bl: Vec<(&u32, &String)> = bases.iter().collect();
    bl.sort();
    for (p, v) in bl {
        out.push_str(&serde_json::json!({ "t": "base", "p": p, "v": v }).to_string());
        out.push('\n');
    }
    let tmp = f.with_extension("jsonl.tmp");
    fs::write(&tmp, out)?;
    fs::rename(&tmp, &f)?;
    Ok(true)
}

/// 봉인 (시간 끝 + 30분 지났을 때)
pub fn seal_if_due(root: &Path, key: &str, now: u64) -> bool {
    let f = file_of(root, key);
    if !f.exists() || crate::patch_store::read_seal(&f).is_some() { return false; }
    let Some((_, end)) = crate::patch_store::key_range(key) else { return false };
    if now < end + SEAL_GRACE_MS { return false; }
    crate::patch_store::seal_plain(&f).is_ok()
}

/// 파일 하나 읽기: (패치의 에피소드들, 기저 리듬)
pub fn read_file(path: &Path, patch: u32) -> Option<(Vec<Ep>, Option<String>)> {
    let text = fs::read_to_string(path).ok()?;
    let mut eps = Vec::new();
    let mut base = None;
    for l in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
        if v["p"].as_u64() != Some(patch as u64) { continue; }
        match v["t"].as_str() {
            Some("ep") => eps.push((patch, v["k"].as_str().unwrap_or("").to_string(), v["v"].as_str().unwrap_or("").to_string(), v["s"].as_u64().unwrap_or(0), v["e"].as_u64())),
            Some("base") => base = v["v"].as_str().map(String::from),
            _ => {}
        }
    }
    Some((eps, base))
}

/// [lo, hi) 의 모든 시간 파일을 읽어 (전체 환자 에피소드, 기저 리듬). 한 시간이라도 없으면 None (부르는 쪽이 에뮬레이터로).
/// restore: 로컬에 없을 때 백업에서 받아 올 경로를 돌려주는 함수
pub fn load_range(root: &Path, lo: u64, hi: u64, restore: &dyn Fn(&str) -> Option<PathBuf>) -> Option<(Vec<Ep>, HashMap<u32, String>)> {
    let mut seen: HashMap<(u32, u64, String, String), Option<u64>> = HashMap::new();
    let mut base: HashMap<u32, String> = HashMap::new();
    let mut h = lo / 3_600_000 * 3_600_000;
    while h < hi {
        let key = crate::patch_store::hour_key(h);
        let mut f = file_of(root, &key);
        if !f.exists() { f = restore(&rel_of(&key))?; }
        let text = fs::read_to_string(&f).ok()?;
        for l in text.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
            let Some(p) = v["p"].as_u64().map(|x| x as u32) else { continue };
            match v["t"].as_str() {
                Some("ep") => { let slot = seen.entry((p, v["s"].as_u64().unwrap_or(0), v["k"].as_str().unwrap_or("").to_string(), v["v"].as_str().unwrap_or("").to_string())).or_insert(None); if let Some(e) = v["e"].as_u64() { *slot = Some(e); } }
                Some("base") => { if let Some(b) = v["v"].as_str() { base.insert(p, b.to_string()); } }
                _ => {}
            }
        }
        h += 3_600_000;
    }
    Some((seen.into_iter().map(|((p, s, k, v), e)| (p, k, v, s, e)).collect(), base))
}

/// 보관된 시간 키 목록 (정렬)
pub fn keys(root: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir(root)).map(|rd| rd.flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".jsonl").map(String::from)).collect()).unwrap_or_default();
    v.sort();
    v
}

/// 오래된 로컬 정답 파일 정리: 봉인되고 백업이 끝난(또는 백업 대상이 없는) 것 중 KEEP_DAYS 보다 오래된 것
pub fn prune(root: &Path, now: u64) -> usize {
    let mut n = 0;
    for key in keys(root) {
        let Some((_, end)) = crate::patch_store::key_range(&key) else { continue };
        if end + KEEP_DAYS * 86_400_000 > now { continue; }
        let f = file_of(root, &key);
        let Some(seal) = crate::patch_store::read_seal(&f) else { continue };
        let rel = rel_of(&key);
        if !crate::backup::may_delete(&rel, seal.size) { continue; }
        if fs::remove_file(&f).is_ok() {
            let _ = fs::remove_file(crate::patch_store::seal_path(&f));
            crate::backup::forgotten(rel);
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn write_seal_read_roundtrip() {
        let root = std::env::temp_dir().join(format!("truth-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let key = "20200101-00";
        let (a, _) = crate::patch_store::key_range(key).unwrap();
        let eps: Vec<Ep> = vec![(7, "rhythm_episode".into(), "afib".into(), a + 1000, Some(a + 60_000)), (8, "lead_off".into(), "lead_off".into(), a, None)];
        let mut bases = HashMap::new();
        bases.insert(7u32, "nsr".to_string());
        assert!(write_hour(&root, key, &eps, &bases, "emu").unwrap());
        let (e, b) = read_file(&file_of(&root, key), 7).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].2, "afib");
        assert_eq!(b.as_deref(), Some("nsr"));
        // 시간이 한참 지났으니 봉인되고, 봉인 뒤에는 다시 쓰지 않는다
        assert!(seal_if_due(&root, key, crate::protocol::now_ms()));
        assert!(crate::patch_store::read_seal(&file_of(&root, key)).is_some());
        assert!(!write_hour(&root, key, &[], &HashMap::new(), "emu").unwrap());
        assert_eq!(read_file(&file_of(&root, key), 7).unwrap().0.len(), 1);
        assert_eq!(keys(&root), vec![key.to_string()]);
        let _ = fs::remove_dir_all(&root);
    }
}
