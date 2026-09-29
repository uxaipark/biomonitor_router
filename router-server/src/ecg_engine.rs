//! live-ecg 엔진 로더 — `libecg.so` 를 실행 중에 읽어 쓰는 호스트 (ABI 1.x, dist/ecg.h).
//!
//! 엔진은 자주 바뀌고(레포에서 최신 알고리즘을 계속 공급) 라우터는 바뀌지 않아야 하므로, 라우터는 엔진을 링크하지 않고
//! 공유 라이브러리를 경로(`ROUTER_ECG_LIB`, 기본 `data/engine/libecg.so`)로 읽는다. 파일이 바뀌면(`scripts/update-ecg-engine.sh`)
//! 분석 스레드가 채널을 모두 새 엔진으로 다시 만든다 — 라우터 재시작·재빌드 없음.
//!
//! 규칙(ecg.h): 메이저가 다르면 거부, 모르는 kind/code 는 건너뜀, 구조체엔 struct_size, 경계 너머로 unwind 없음.
//! 채널은 스레드 사이에 공유하지 않는다. 라이브러리는 `Arc` 로 들고 있어 채널이 모두 사라진 뒤에야 닫힌다(dlclose).
use std::ffi::{c_char, CStr, CString};
use std::sync::Arc;

pub const ABI_MAJOR: u32 = 1;
pub const ECG_PRESET_CLINICAL: u32 = 0;
pub const ECG_PRESET_PATCH: u32 = 1;

pub const EV_BEAT: u32 = 1;
pub const EV_RHYTHM: u32 = 2;
pub const EV_AF_WINDOW: u32 = 3;
pub const EV_VF: u32 = 4;
pub const EV_LEAD_OFF: u32 = 5;
pub const EV_SV_RUN: u32 = 6;
pub const BEAT_N: u32 = 0;
pub const BEAT_S: u32 = 1;
pub const BEAT_V: u32 = 2;
pub const BEAT_F: u32 = 3;
pub const BEAT_UNKNOWN: u32 = 4;
pub const RHYTHM_PAUSE: u32 = 1;
pub const RHYTHM_ASYSTOLE: u32 = 2;
pub const RHYTHM_BRADYCARDIA: u32 = 3;
pub const RHYTHM_TACHYCARDIA: u32 = 4;
pub const RHYTHM_VENTRICULAR_RUN: u32 = 5;
pub const RHYTHM_VENTRICULAR_TACHYCARDIA: u32 = 6;
pub const RHYTHM_BIGEMINY: u32 = 7;
pub const RHYTHM_TRIGEMINY: u32 = 8;
pub const RHYTHM_IDIOVENTRICULAR: u32 = 9;
pub const AF_FLAG_IN_AF: u32 = 1;
pub const STATE_IN_AF: u32 = 1;
pub const STATE_IN_VF: u32 = 2;
pub const STATE_LEAD_OFF: u32 = 4;
pub const STATE_SUPPRESSING: u32 = 8;
pub const QUALITY_GOOD: u32 = 0;
pub const QUALITY_ACCEPTABLE: u32 = 1;
pub const QUALITY_UNUSABLE: u32 = 2;
pub const QUALITY_UNKNOWN: u32 = 3;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct EcgConfig {
    pub struct_size: u32,
    pub preset: u32,
    pub fs: f64,
    pub stages: *const c_char,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct EcgEvent {
    pub kind: u32,
    pub code: u32,
    pub flags: u32,
    pub aux: u32,
    pub start: u64,
    pub end: u64,
    pub score: [f32; 4],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct EcgStatus {
    pub struct_size: u32,
    pub quality: u32,
    pub state: u32,
    pub reserved: u32,
    pub samples: u64,
    pub quality_score: f32,
}

#[repr(C)]
pub struct EcgChannelOpaque {
    _p: [u8; 0],
}

type AbiVersionFn = unsafe extern "C" fn() -> u32;
type EngineIdFn = unsafe extern "C" fn() -> *const c_char;
type CreateFn = unsafe extern "C" fn(*const EcgConfig, *mut i32) -> *mut EcgChannelOpaque;
type DestroyFn = unsafe extern "C" fn(*mut EcgChannelOpaque);
type PushFn = unsafe extern "C" fn(*mut EcgChannelOpaque, *const f32, usize) -> i32;
type GapFn = unsafe extern "C" fn(*mut EcgChannelOpaque, u64) -> i32;
type PollFn = unsafe extern "C" fn(*mut EcgChannelOpaque, *mut EcgEvent, usize) -> i64;
type StatusFn = unsafe extern "C" fn(*mut EcgChannelOpaque, *mut EcgStatus) -> i32;
type EngineStagesFn = unsafe extern "C" fn() -> *const c_char;
type ChannelStagesFn = unsafe extern "C" fn(*mut EcgChannelOpaque) -> *const c_char;

/// 읽어 들인 엔진 하나. `Arc` 로 채널들이 붙잡는다.
pub struct Engine {
    _lib: libloading::Library,
    create: CreateFn,
    destroy: DestroyFn,
    push: PushFn,
    gap: GapFn,
    poll: PollFn,
    status: StatusFn,
    channel_stages: Option<ChannelStagesFn>,
    pub id: String,
    pub abi: (u32, u32),
    pub stages: Vec<(String, String)>,
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

// 채널은 한 스레드만 만지지만 엔진(라이브러리) 자체는 스레드를 가리지 않는다
unsafe impl Send for Engine {}
unsafe impl Sync for Engine {}

fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

impl Engine {
    pub fn load(path: &str) -> Result<Arc<Engine>, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
        let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        // SAFETY: 엔진의 초기화 루틴은 없다(ecg.h). 심볼은 아래에서 모두 확인한다.
        let lib = unsafe { libloading::Library::new(path) }.map_err(|e| format!("{path}: {e}"))?;
        unsafe {
            let abi: AbiVersionFn = *lib.get(b"ecg_abi_version\0").map_err(|e| e.to_string())?;
            let v = abi();
            let (major, minor) = (v >> 16, v & 0xffff);
            if major != ABI_MAJOR {
                return Err(format!("엔진 ABI {major}.{minor} — 라우터는 {ABI_MAJOR}.x 만 지원"));
            }
            let id_fn: EngineIdFn = *lib.get(b"ecg_engine_id\0").map_err(|e| e.to_string())?;
            let id = cstr(id_fn());
            let create: CreateFn = *lib.get(b"ecg_channel_create\0").map_err(|e| e.to_string())?;
            let destroy: DestroyFn = *lib.get(b"ecg_channel_destroy\0").map_err(|e| e.to_string())?;
            let push: PushFn = *lib.get(b"ecg_channel_push\0").map_err(|e| e.to_string())?;
            let gap: GapFn = *lib.get(b"ecg_channel_gap\0").map_err(|e| e.to_string())?;
            let poll: PollFn = *lib.get(b"ecg_channel_poll\0").map_err(|e| e.to_string())?;
            let status: StatusFn = *lib.get(b"ecg_channel_status\0").map_err(|e| e.to_string())?;
            let mut stages = Vec::new();
            if minor >= 1 {
                if let Ok(f) = lib.get::<EngineStagesFn>(b"ecg_engine_stages\0") {
                    for line in cstr(f()).lines() {
                        let mut it = line.splitn(2, '\t');
                        let name = it.next().unwrap_or("").trim().to_string();
                        if !name.is_empty() {
                            stages.push((name, it.next().unwrap_or("").trim().to_string()));
                        }
                    }
                }
            }
            let channel_stages = if minor >= 1 { lib.get::<ChannelStagesFn>(b"ecg_channel_stages\0").ok().map(|s| *s) } else { None };
            Ok(Arc::new(Engine { create, destroy, push, gap, poll, status, channel_stages, id, abi: (major, minor), stages, path: path.to_string(), mtime_ms, size: meta.len(), _lib: lib }))
        }
    }

    /// 채널 하나 (한 스트림). `stages` 는 "kind=name;…" 또는 빈 문자열(프리셋 기본).
    pub fn channel(self: &Arc<Self>, fs: f64, preset: u32, stages: &str) -> Result<Channel, i32> {
        let cs = CString::new(stages).unwrap_or_default();
        let cfg = EcgConfig { struct_size: std::mem::size_of::<EcgConfig>() as u32, preset, fs, stages: if stages.is_empty() { std::ptr::null() } else { cs.as_ptr() } };
        let mut err: i32 = 0;
        let p = unsafe { (self.create)(&cfg, &mut err) };
        if p.is_null() {
            return Err(err);
        }
        Ok(Channel { ptr: p, engine: Arc::clone(self), poisoned: false })
    }
}

pub struct Channel {
    ptr: *mut EcgChannelOpaque,
    engine: Arc<Engine>,
    poisoned: bool,
}
unsafe impl Send for Channel {}

impl Channel {
    pub fn push(&mut self, mv: &[f32]) -> i32 {
        if self.poisoned || mv.is_empty() {
            return 0;
        }
        let r = unsafe { (self.engine.push)(self.ptr, mv.as_ptr(), mv.len()) };
        if r < 0 {
            self.poisoned = true;
        }
        r
    }
    pub fn gap(&mut self, samples: u64) -> i32 {
        if self.poisoned || samples == 0 {
            return 0;
        }
        let r = unsafe { (self.engine.gap)(self.ptr, samples) };
        if r < 0 {
            self.poisoned = true;
        }
        r
    }
    pub fn poll(&mut self, out: &mut Vec<EcgEvent>) {
        if self.poisoned {
            return;
        }
        let mut buf = [EcgEvent::default(); 64];
        loop {
            let n = unsafe { (self.engine.poll)(self.ptr, buf.as_mut_ptr(), buf.len()) };
            if n < 0 {
                self.poisoned = true;
                return;
            }
            out.extend_from_slice(&buf[..n as usize]);
            if (n as usize) < buf.len() {
                return;
            }
        }
    }
    pub fn status(&mut self) -> EcgStatus {
        let mut st = EcgStatus { struct_size: std::mem::size_of::<EcgStatus>() as u32, ..Default::default() };
        if !self.poisoned {
            let r = unsafe { (self.engine.status)(self.ptr, &mut st) };
            if r < 0 {
                self.poisoned = true;
            }
        }
        st
    }
    pub fn stages(&self) -> String {
        match self.engine.channel_stages {
            Some(f) => cstr(unsafe { f(self.ptr) }),
            None => String::new(),
        }
    }
    pub fn poisoned(&self) -> bool {
        self.poisoned
    }
    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        unsafe { (self.engine.destroy)(self.ptr) }
    }
}

pub fn rhythm_name(code: u32) -> &'static str {
    match code {
        RHYTHM_PAUSE => "pause",
        RHYTHM_ASYSTOLE => "asystole",
        RHYTHM_BRADYCARDIA => "brady",
        RHYTHM_TACHYCARDIA => "tachy",
        RHYTHM_VENTRICULAR_RUN => "vrun",
        RHYTHM_VENTRICULAR_TACHYCARDIA => "vtach",
        RHYTHM_BIGEMINY => "bigeminy",
        RHYTHM_TRIGEMINY => "trigeminy",
        RHYTHM_IDIOVENTRICULAR => "ivr",
        _ => "rhythm",
    }
}
