//! 시스템 리소스 모니터링 (어드민 통계 타일용).
//! - Windows: GetSystemTimes / GetDiskFreeSpaceExW
//! - macOS: mach host_statistics / sysctl / statvfs

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// 시스템 전체 CPU 사용률 (0~1000, 퍼밀 단위)
pub static CPU_PERMILLE: AtomicU64 = AtomicU64::new(0);

pub fn cpu_percent() -> f32 {
    CPU_PERMILLE.load(Ordering::Relaxed) as f32 / 10.0
}

/// 라우터 프로세스 자체의 CPU 사용률 (1코어 = 100 %, 퍼밀 단위; Linux 만 채워짐)
pub static PROC_CPU_PERMILLE: AtomicU64 = AtomicU64::new(0);

pub fn proc_cpu_percent() -> f32 {
    PROC_CPU_PERMILLE.load(Ordering::Relaxed) as f32 / 10.0
}

#[cfg(windows)]
fn system_times() -> Option<(u64, u64, u64)> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetSystemTimes;
    unsafe {
        let mut idle: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) == 0 {
            return None;
        }
        let f = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
        Some((f(idle), f(kernel), f(user)))
    }
}

/// macOS 네이티브 수집 (mach FFI — libSystem 에 항상 링크됨)
#[cfg(target_os = "macos")]
mod mac {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct HostCpuLoadInfo {
        /// user / system / idle / nice 틱 (u32, 랩어라운드는 wrapping_sub 로 처리)
        pub ticks: [u32; 4],
    }

    #[repr(C)]
    struct TimeValue {
        seconds: i32,
        microseconds: i32,
    }

    /// MACH_TASK_BASIC_INFO (flavor 20)
    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: TimeValue,
        system_time: TimeValue,
        policy: i32,
        suspend_count: i32,
    }

    /// HOST_VM_INFO64 (flavor 4) — mach/vm_statistics.h 의 vm_statistics64
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct VmStatistics64 {
        free_count: u32,
        active_count: u32,
        inactive_count: u32,
        wire_count: u32,
        zero_fill_count: u64,
        reactivations: u64,
        pageins: u64,
        pageouts: u64,
        faults: u64,
        cow_faults: u64,
        lookups: u64,
        hits: u64,
        purges: u64,
        purgeable_count: u32,
        speculative_count: u32,
        decompressions: u64,
        compressions: u64,
        swapins: u64,
        swapouts: u64,
        compressor_page_count: u32,
        throttled_count: u32,
        external_page_count: u32,
        internal_page_count: u32,
        total_uncompressed_pages_in_compressor: u64,
    }

    const HOST_CPU_LOAD_INFO: i32 = 3;
    const HOST_VM_INFO64: i32 = 4;
    const MACH_TASK_BASIC_INFO: u32 = 20;

    extern "C" {
        static mach_task_self_: u32;
        fn mach_host_self() -> u32;
        fn host_statistics(host: u32, flavor: i32, info: *mut u32, count: *mut u32) -> i32;
        fn host_statistics64(host: u32, flavor: i32, info: *mut u32, count: *mut u32) -> i32;
        fn task_info(task: u32, flavor: u32, info: *mut u32, count: *mut u32) -> i32;
    }

    /// (busy 틱, 전체 틱)
    pub fn cpu_ticks() -> Option<(u64, u64)> {
        unsafe {
            let mut info = HostCpuLoadInfo::default();
            let mut count = 4u32;
            let rc = host_statistics(
                mach_host_self(),
                HOST_CPU_LOAD_INFO,
                &mut info as *mut _ as *mut u32,
                &mut count,
            );
            if rc != 0 {
                return None;
            }
            let [user, system, idle, nice] = info.ticks;
            let busy = user as u64 + system as u64 + nice as u64;
            Some((busy, busy + idle as u64))
        }
    }

    fn page_size() -> u64 {
        unsafe { libc::sysconf(libc::_SC_PAGESIZE).max(4096) as u64 }
    }

    /// 물리 메모리 전체 (hw.memsize)
    fn total_mem() -> u64 {
        unsafe {
            let mut v: u64 = 0;
            let mut len = std::mem::size_of::<u64>();
            let name = b"hw.memsize\0";
            if libc::sysctlbyname(
                name.as_ptr() as *const libc::c_char,
                &mut v as *mut _ as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            ) == 0
            {
                v
            } else {
                0
            }
        }
    }

    /// (프로세스 RSS, 시스템 사용, 시스템 전체) — 사용 = (active+wired+compressed)×page
    pub fn memory_stats() -> (u64, u64, u64) {
        let page = page_size();
        let rss = unsafe {
            let mut info: MachTaskBasicInfo = std::mem::zeroed();
            let mut count = (std::mem::size_of::<MachTaskBasicInfo>() / 4) as u32;
            if task_info(
                mach_task_self_,
                MACH_TASK_BASIC_INFO,
                &mut info as *mut _ as *mut u32,
                &mut count,
            ) == 0
            {
                info.resident_size
            } else {
                0
            }
        };
        let used = unsafe {
            let mut vm = VmStatistics64::default();
            let mut count = (std::mem::size_of::<VmStatistics64>() / 4) as u32;
            if host_statistics64(
                mach_host_self(),
                HOST_VM_INFO64,
                &mut vm as *mut _ as *mut u32,
                &mut count,
            ) == 0
            {
                (vm.active_count as u64 + vm.wire_count as u64 + vm.compressor_page_count as u64)
                    * page
            } else {
                0
            }
        };
        (rss, used, total_mem())
    }

    /// 루트 볼륨 (전체, 여유) 바이트
    pub fn disk_stats() -> (u64, u64) {
        unsafe {
            let path = b"/\0";
            let mut st: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(path.as_ptr() as *const libc::c_char, &mut st) == 0 {
                let fr = st.f_frsize as u64;
                ((st.f_blocks as u64) * fr, (st.f_bavail as u64) * fr)
            } else {
                (0, 0)
            }
        }
    }
}

/// (프로세스 RSS, 시스템 사용, 시스템 전체) — 플랫폼별 구현, 미지원 플랫폼은 0
pub fn memory_stats_native() -> (u64, u64, u64) {
    #[cfg(target_os = "macos")]
    {
        mac::memory_stats()
    }
    #[cfg(target_os = "linux")]
    {
        linux::memory_stats()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        (0, 0, 0)
    }
}

/// Linux (RP5): /proc 기반 수집
#[cfg(target_os = "linux")]
mod linux {
    fn meminfo_kb(key: &str, text: &str) -> u64 {
        text.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
    }

    /// (프로세스 RSS, 시스템 사용, 시스템 전체)
    pub fn memory_stats() -> (u64, u64, u64) {
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) as u64;
        let rss = std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|s| s.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()))
            .unwrap_or(0)
            * page;
        let mi = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let total = meminfo_kb("MemTotal:", &mi) * 1024;
        let avail = meminfo_kb("MemAvailable:", &mi) * 1024;
        (rss, total.saturating_sub(avail), total)
    }

    /// 프로세스 utime+stime 틱 — /proc/self/stat 14·15 번째 필드
    pub fn proc_cpu_ticks() -> Option<u64> {
        let s = std::fs::read_to_string("/proc/self/stat").ok()?;
        let rest = &s[s.rfind(')')? + 2..];
        let v: Vec<&str> = rest.split_whitespace().collect();
        Some(v.get(11)?.parse::<u64>().ok()? + v.get(12)?.parse::<u64>().ok()?)
    }

    /// (busy ticks, total ticks) — /proc/stat 첫 줄
    pub fn cpu_ticks() -> Option<(u64, u64)> {
        let s = std::fs::read_to_string("/proc/stat").ok()?;
        let line = s.lines().next()?;
        let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
        if v.len() < 4 {
            return None;
        }
        let total: u64 = v.iter().sum();
        let idle = v[3] + v.get(4).copied().unwrap_or(0);
        Some((total - idle, total))
    }

    /// (전체, 여유) 바이트 — 저장소 루트(`ROUTER_STORE_DIR`)가 있는 파일시스템
    pub fn disk_stats() -> (u64, u64) {
        let mut path = std::env::var("ROUTER_STORE_DIR").unwrap_or_else(|_| ".".into());
        if !std::path::Path::new(&path).exists() {
            path = ".".into();
        }
        let Ok(c) = std::ffi::CString::new(path) else { return (0, 0) };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } == 0 {
            let fr = st.f_frsize as u64;
            ((st.f_blocks as u64) * fr, (st.f_bavail as u64) * fr)
        } else {
            (0, 0)
        }
    }
}

/// CPU 사용률 샘플러 (백그라운드 태스크).
pub async fn run_cpu_sampler() {
    #[cfg(windows)]
    {
        let mut prev = system_times();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let cur = system_times();
            if let (Some((pi, pk, pu)), Some((ci, ck, cu))) = (prev, cur) {
                let idle = ci.saturating_sub(pi);
                let total = ck.saturating_sub(pk) + cu.saturating_sub(pu);
                if total > 0 {
                    let busy = total.saturating_sub(idle);
                    CPU_PERMILLE.store(busy * 1000 / total, Ordering::Relaxed);
                }
            }
            prev = cur;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut prev = linux::cpu_ticks();
        let mut prev_proc = linux::proc_cpu_ticks();
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let cur = linux::cpu_ticks();
            if let (Some((pb, pt)), Some((cb, ct))) = (prev, cur) {
                let busy = cb.wrapping_sub(pb);
                let total = ct.wrapping_sub(pt);
                if total > 0 && total < u64::MAX / 1000 {
                    CPU_PERMILLE.store(busy * 1000 / total, Ordering::Relaxed);
                }
            }
            prev = cur;
            let cur_proc = linux::proc_cpu_ticks();
            if let (Some(p), Some(c)) = (prev_proc, cur_proc) {
                // ticks over a 2 s window → permille of one core
                PROC_CPU_PERMILLE.store(c.wrapping_sub(p) * 1000 / (hz * 2), Ordering::Relaxed);
            }
            prev_proc = cur_proc;
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut prev = mac::cpu_ticks();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let cur = mac::cpu_ticks();
            if let (Some((pb, pt)), Some((cb, ct))) = (prev, cur) {
                let busy = cb.wrapping_sub(pb);
                let total = ct.wrapping_sub(pt);
                if total > 0 && total < u64::MAX / 1000 {
                    CPU_PERMILLE.store(busy * 1000 / total, Ordering::Relaxed);
                }
            }
            prev = cur;
        }
    }
}

/// (전체 바이트, 여유 바이트) — 라우터가 위치한 드라이브 기준
pub fn disk_stats() -> (u64, u64) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let path: Vec<u16> = "C:\\".encode_utf16().chain(std::iter::once(0)).collect();
        let mut free_caller: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        if GetDiskFreeSpaceExW(path.as_ptr(), &mut free_caller, &mut total, &mut total_free) != 0 {
            (total, total_free)
        } else {
            (0, 0)
        }
    }
    #[cfg(target_os = "macos")]
    {
        mac::disk_stats()
    }
    #[cfg(target_os = "linux")]
    {
        linux::disk_stats()
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        (0, 0)
    }
}
