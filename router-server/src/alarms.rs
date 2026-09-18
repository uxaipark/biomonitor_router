//! Alarm engine: evaluates the registry (latest vitals, flags, liveness) and the gateway table once a second
//! and keeps a book of active alarms. A numeric threshold has to be violated for `sustain_s` before it raises,
//! so a single bad reading does not page anyone; an alarm clears itself when the condition has been gone for
//! `clear_s`. Raise/clear are pushed to WS subscribers of the pseudo group `alarms` and kept in a history ring.

use crate::protocol::{now_ms, OutMsg};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const GROUP: &str = "alarms";
const HISTORY: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rules {
    pub hr_low: u8,
    pub hr_high: u8,
    pub hr_crit_low: u8,
    pub hr_crit_high: u8,
    pub spo2_low: u8,
    pub spo2_crit_low: u8,
    pub temp_low: f32,
    pub temp_high: f32,
    pub resp_low: u8,
    pub resp_high: u8,
    pub battery_low_pct: u8,
    /// Numeric limits must stay violated this long before the alarm raises.
    pub sustain_s: u64,
    /// LEAD_OFF / SPO2_SENSOR_OFF must persist this long.
    pub lead_off_s: u64,
    /// A connected patch with no records for this long.
    pub patch_silent_s: u64,
    /// The condition must be gone this long before the alarm clears.
    pub clear_s: u64,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            hr_low: 40,
            hr_high: 130,
            hr_crit_low: 30,
            hr_crit_high: 180,
            spo2_low: 90,
            spo2_crit_low: 85,
            temp_low: 35.0,
            temp_high: 38.5,
            resp_low: 8,
            resp_high: 30,
            battery_low_pct: 10,
            sustain_s: 10,
            lead_off_s: 30,
            patch_silent_s: 15,
            clear_s: 5,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub struct Alarm {
    pub id: u64,
    pub kind: String,
    pub severity: Severity,
    /// Patch id for patient alarms, empty for gateway/system alarms.
    pub channel_id: String,
    pub gateway_id: String,
    pub patient_id: u32,
    pub patient_name: String,
    pub room: String,
    pub value: String,
    pub message: String,
    pub since_ms: u64,
    pub last_ms: u64,
    pub acked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleared_ms: Option<u64>,
}

/// A condition observed this tick (before sustain/clear hysteresis).
struct Observed {
    kind: &'static str,
    severity: Severity,
    channel_id: String,
    gateway_id: String,
    patient_id: u32,
    patient_name: String,
    room: String,
    value: String,
    message: String,
    /// Sustain required before raising (seconds).
    sustain: u64,
}

#[derive(Default)]
struct Book {
    rules: Rules,
    /// (kind, subject) → first time the condition was seen (pending raise)
    pending: HashMap<(String, String), u64>,
    /// (kind, subject) → active alarm
    active: HashMap<(String, String), Alarm>,
    /// (kind, subject) → when the condition was last observed (for clear hysteresis)
    last_seen: HashMap<(String, String), u64>,
    history: std::collections::VecDeque<Alarm>,
}

pub struct AlarmBook {
    inner: Mutex<Book>,
    next_id: AtomicU64,
}

impl Default for AlarmBook {
    fn default() -> Self {
        Self::new()
    }
}

impl AlarmBook {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Book::default()), next_id: AtomicU64::new(1) }
    }

    pub fn rules(&self) -> Rules {
        self.inner.lock().unwrap().rules.clone()
    }

    pub fn set_rules(&self, r: Rules) {
        self.inner.lock().unwrap().rules = r;
    }

    pub fn active(&self) -> Vec<Alarm> {
        let mut v: Vec<Alarm> = self.inner.lock().unwrap().active.values().cloned().collect();
        v.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.since_ms.cmp(&b.since_ms)));
        v
    }

    pub fn history(&self, limit: usize) -> Vec<Alarm> {
        let b = self.inner.lock().unwrap();
        b.history.iter().rev().take(limit).cloned().collect()
    }

    pub fn ack(&self, id: u64) -> bool {
        let mut b = self.inner.lock().unwrap();
        for a in b.active.values_mut() {
            if a.id == id {
                a.acked = true;
                return true;
            }
        }
        false
    }

    pub fn sizes(&self) -> serde_json::Value {
        let b = self.inner.lock().unwrap();
        serde_json::json!({"active": b.active.len(), "pending": b.pending.len(), "last_seen": b.last_seen.len(), "history": b.history.len()})
    }

    /// Counts by severity for the status report / dashboard.
    pub fn summary(&self) -> serde_json::Value {
        let b = self.inner.lock().unwrap();
        let mut c = [0u64; 4];
        let mut unacked = 0u64;
        for a in b.active.values() {
            c[a.severity as usize] += 1;
            if !a.acked {
                unacked += 1;
            }
        }
        serde_json::json!({
            "active": b.active.len(), "unacked": unacked,
            "critical": c[3], "high": c[2], "medium": c[1], "low": c[0],
        })
    }
}

/// One evaluation pass. Returns the alarms raised and cleared this tick (already applied to the book).
pub fn evaluate(state: &Arc<AppState>) -> (Vec<Alarm>, Vec<Alarm>) {
    let now = now_ms();
    let rules = state.alarms.rules();
    let mut seen: Vec<Observed> = Vec::new();

    for ch in state.registry.snapshot() {
        if !ch.connected {
            continue;
        }
        let (pname, room) = ch
            .patient
            .as_ref()
            .map(|p| (p.name.clone(), if p.room.is_empty() { ch.space.clone() } else { p.room.clone() }))
            .unwrap_or_else(|| (String::new(), ch.space.clone()));
        let base = |kind: &'static str, sev: Severity, value: String, msg: String, sustain: u64| Observed {
            kind,
            severity: sev,
            channel_id: ch.channel_id.clone(),
            gateway_id: ch.gateway_id.clone(),
            patient_id: ch.patient_id,
            patient_name: pname.clone(),
            room: room.clone(),
            value,
            message: msg,
            sustain,
        };
        // Liveness first: a silent patch's stale vitals must not raise vital alarms.
        if ch.last_ts_ms > 0 && now.saturating_sub(ch.last_ts_ms) > rules.patch_silent_s * 1000 {
            let s = now.saturating_sub(ch.last_ts_ms) / 1000;
            seen.push(base("patch_silent", Severity::Medium, format!("{s}s"), format!("패치 수신 중단 {s}초"), 0));
            continue;
        }
        let lead_off = ch.flags & crate::wire::R_LEAD_OFF != 0;
        if lead_off {
            seen.push(base("lead_off", Severity::Medium, "LEAD_OFF".into(), "ECG 전극 탈락".into(), rules.lead_off_s));
        }
        if ch.flags & crate::wire::R_SPO2_OFF != 0 {
            seen.push(base("spo2_sensor_off", Severity::Low, "SPO2_OFF".into(), "SpO2 센서 이탈".into(), rules.lead_off_s));
        }
        if ch.battery > 0 && ch.battery <= rules.battery_low_pct && ch.flags & crate::wire::R_CHARGING == 0 {
            seen.push(base("battery_low", Severity::Low, format!("{}%", ch.battery), format!("배터리 {}%", ch.battery), 0));
        }
        // Vitals are only trusted while fresh (< 5 s) and the electrodes are on.
        let fresh = ch.vitals_ts_ms > 0 && now.saturating_sub(ch.vitals_ts_ms) < 5000;
        if !fresh || lead_off {
            continue;
        }
        let v = &ch.vitals;
        if let Some(hr) = v.hr {
            if hr <= rules.hr_crit_low || hr >= rules.hr_crit_high {
                seen.push(base("hr_critical", Severity::Critical, format!("{hr} bpm"), format!("심박수 위험 {hr} bpm"), rules.sustain_s));
            } else if hr < rules.hr_low {
                seen.push(base("hr_low", Severity::High, format!("{hr} bpm"), format!("서맥 {hr} bpm"), rules.sustain_s));
            } else if hr > rules.hr_high {
                seen.push(base("hr_high", Severity::High, format!("{hr} bpm"), format!("빈맥 {hr} bpm"), rules.sustain_s));
            }
        }
        if let Some(sp) = v.spo2 {
            if ch.flags & crate::wire::R_SPO2_OFF == 0 {
                if sp < rules.spo2_crit_low {
                    seen.push(base("spo2_critical", Severity::Critical, format!("{sp}%"), format!("SpO2 위험 {sp}%"), rules.sustain_s));
                } else if sp < rules.spo2_low {
                    seen.push(base("spo2_low", Severity::High, format!("{sp}%"), format!("저산소 SpO2 {sp}%"), rules.sustain_s));
                }
            }
        }
        if let Some(t) = v.temp {
            if t >= rules.temp_high {
                seen.push(base("temp_high", Severity::Medium, format!("{t:.1}°C"), format!("고열 {t:.1}°C"), rules.sustain_s));
            } else if t <= rules.temp_low {
                seen.push(base("temp_low", Severity::Medium, format!("{t:.1}°C"), format!("저체온 {t:.1}°C"), rules.sustain_s));
            }
        }
        if let Some(r) = v.resp {
            if r < rules.resp_low {
                seen.push(base("resp_low", Severity::High, format!("{r} brpm"), format!("서호흡 {r} brpm"), rules.sustain_s));
            } else if r > rules.resp_high {
                seen.push(base("resp_high", Severity::High, format!("{r} brpm"), format!("빈호흡 {r} brpm"), rules.sustain_s));
            }
        }
    }

    for gw in state.gateways.snapshot() {
        let subject = gw.gw_id.to_string();
        let mk = |kind: &'static str, sev: Severity, value: String, msg: String| Observed {
            kind,
            severity: sev,
            channel_id: String::new(),
            gateway_id: subject.clone(),
            patient_id: 0,
            patient_name: String::new(),
            room: gw.location.room.clone(),
            value,
            message: msg,
            sustain: 0,
        };
        if !gw.connected {
            // Only gateways that carried patches matter; an idle row that never had patches is noise.
            if gw.patches > 0 {
                seen.push(mk("gateway_down", Severity::High, "disconnected".into(), format!("게이트웨이 {} 연결 끊김 ({}명)", gw.name, gw.patches)));
            }
        } else if gw.silent {
            seen.push(mk("gateway_silent", Severity::High, "silent".into(), format!("게이트웨이 {} 무응답 (소켓 유지, 프레임 없음)", gw.name)));
        } else if let Some(st) = gw.status {
            if st.status == 2 {
                seen.push(mk("gateway_status_down", Severity::High, "status=2".into(), format!("게이트웨이 {} 자체 보고 DOWN", gw.name)));
            } else if st.status == 1 {
                seen.push(mk("gateway_degraded", Severity::Low, format!("cpu {}% net {}%", st.cpu, st.net), format!("게이트웨이 {} 성능 저하", gw.name)));
            }
        }
    }

    let store_dropped = state.dropped_wave.load(Ordering::Relaxed);
    if store_dropped > 0 && now.saturating_sub(state.last_store_drop_ms.load(Ordering::Relaxed)) < 60_000 {
        seen.push(Observed {
            kind: "store_backpressure",
            severity: Severity::High,
            channel_id: String::new(),
            gateway_id: String::new(),
            patient_id: 0,
            patient_name: String::new(),
            room: String::new(),
            value: format!("{store_dropped} dropped"),
            message: "저장 큐 포화: 레코드 드롭 발생 (디스크 정체)".into(),
            sustain: 0,
        });
    }

    // Apply hysteresis against the book.
    let mut raised = Vec::new();
    let mut cleared = Vec::new();
    let mut b = state.alarms.inner.lock().unwrap();
    let clear_ms = b.rules.clear_s * 1000;
    let mut present: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for o in seen {
        let subject = if o.channel_id.is_empty() { o.gateway_id.clone() } else { o.channel_id.clone() };
        let key = (o.kind.to_string(), subject);
        present.insert(key.clone());
        b.last_seen.insert(key.clone(), now);
        if let Some(a) = b.active.get_mut(&key) {
            a.last_ms = now;
            a.value = o.value;
            a.message = o.message;
            if o.severity > a.severity {
                a.severity = o.severity;
            }
            continue;
        }
        let first = *b.pending.entry(key.clone()).or_insert(now);
        if now.saturating_sub(first) >= o.sustain * 1000 {
            b.pending.remove(&key);
            let a = Alarm {
                id: state.alarms.next_id.fetch_add(1, Ordering::Relaxed),
                kind: o.kind.to_string(),
                severity: o.severity,
                channel_id: o.channel_id,
                gateway_id: o.gateway_id,
                patient_id: o.patient_id,
                patient_name: o.patient_name,
                room: o.room,
                value: o.value,
                message: o.message,
                since_ms: first,
                last_ms: now,
                acked: false,
                cleared_ms: None,
            };
            b.active.insert(key, a.clone());
            raised.push(a);
        }
    }
    b.pending.retain(|k, _| present.contains(k));
    let gone: Vec<(String, String)> = b
        .active
        .keys()
        .filter(|k| !present.contains(*k) && now.saturating_sub(b.last_seen.get(*k).copied().unwrap_or(0)) >= clear_ms)
        .cloned()
        .collect();
    for k in gone {
        if let Some(mut a) = b.active.remove(&k) {
            b.last_seen.remove(&k);
            a.cleared_ms = Some(now);
            cleared.push(a);
        }
    }
    for a in raised.iter().chain(cleared.iter()) {
        if b.history.len() >= HISTORY {
            b.history.pop_front();
        }
        b.history.push_back(a.clone());
    }
    (raised, cleared)
}

/// 1 Hz evaluation loop; raise/clear go to WS subscribers of `alarms` and the event ring.
pub async fn run(state: Arc<AppState>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let st = state.clone();
        let (raised, cleared) = tokio::task::spawn_blocking(move || evaluate(&st)).await.unwrap_or_default();
        for a in raised {
            state.push_event("alarm", if a.channel_id.is_empty() { None } else { Some(a.channel_id.clone()) }, format!("[{:?}] {} {}", a.severity, a.patient_name, a.message));
            state.publish(&[GROUP.to_string()], &OutMsg::Alarm { event: "raise".into(), alarm: serde_json::to_value(&a).unwrap_or_default() });
        }
        for a in cleared {
            state.publish(&[GROUP.to_string()], &OutMsg::Alarm { event: "clear".into(), alarm: serde_json::to_value(&a).unwrap_or_default() });
        }
    }
}
