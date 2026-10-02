//! 패치 재고관리 (리셀러·CRM 영업 · 병원 IT) — 병원(테넌트)별 위탁/납품 재고.
//!
//! 업무 절차 (의료 소모품 위탁·파(Par) 재고 관행):
//!  1. 품목(SKU) 등록 — 패치 모델·상자당 수량·단가.
//!  2. 발주(PO): 작성(draft) → 제출(submitted, 리셀러) → 확인(confirmed) → 출고(shipped, 송장번호) → 입고(received, 병원이 로트·유효기간 확인) / 취소.
//!  3. 입고: 로트(LOT)·유효기간·수량으로 재고에 들어온다. 사용은 유효기간이 먼저인 로트부터(FEFO).
//!  4. 사용: 이 라우터 병원(사이트)은 패치 부착(EMR 패치 레지스트리의 발급 시각)마다 자동 차감, 다른 병원은 수동 사용 등록.
//!  5. 조정: 파손·유효기간 만료·반품·기타 사유 코드로 ±. 실사(cycle count)는 센 수량과의 차이를 조정으로 남긴다.
//!  6. 보충 계산: 일평균 사용(최근 30일) d, 표준편차 σ, 리드타임 L, 검토주기 R, 서비스수준 z(95% → 1.65)
//!     안전재고 SS = z·σ·√L, 재주문점 ROP = d·L + SS, 목표재고(Par) = d·(L+R) + SS,
//!     권장 발주 = max(0, Par − (현재고 + 입고 예정)) 을 상자 단위로 올림. 현재고 ≤ ROP 이면 '발주 필요'.
//!     재고 일수 DOS = 현재고 ÷ d. 유효기간 60일 이내 로트는 '임박', 지난 로트는 '만료'(사용 불가 · 폐기 조정 권장).
//! 모든 수량 변화는 원장(inv_ledger)에 남는다(누가·언제·왜).
use crate::state::AppState;
use chrono::{Datelike, TimeZone};
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};

pub struct Inventory {
    db: Mutex<Connection>,
    /// 병원별 현재 착용 인원 (수요 예측 기준선)
    census: Mutex<std::collections::HashMap<String, usize>>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS inv_sku (id TEXT PRIMARY KEY, name TEXT NOT NULL, per_box INTEGER NOT NULL DEFAULT 10, unit_price REAL NOT NULL DEFAULT 0, wear_days REAL NOT NULL DEFAULT 14, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS inv_policy (tenant TEXT NOT NULL, sku TEXT NOT NULL, lead_days REAL NOT NULL DEFAULT 7, review_days REAL NOT NULL DEFAULT 7, service REAL NOT NULL DEFAULT 0.95, min_boxes INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant, sku));
CREATE TABLE IF NOT EXISTS inv_lot (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, sku TEXT NOT NULL, lot TEXT NOT NULL, expiry TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL, received_ms INTEGER NOT NULL, po INTEGER);
CREATE INDEX IF NOT EXISTS inv_lot_t ON inv_lot(tenant, sku);
CREATE TABLE IF NOT EXISTS inv_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, tenant TEXT NOT NULL, sku TEXT NOT NULL, lot INTEGER, kind TEXT NOT NULL, qty INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '', by_user TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS inv_ledger_t ON inv_ledger(tenant, sku, ms);
CREATE TABLE IF NOT EXISTS inv_po (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, sku TEXT NOT NULL, boxes INTEGER NOT NULL, status TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, by_user TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', eta TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS inv_seen (patch TEXT PRIMARY KEY, ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS patch_base (patch INTEGER PRIMARY KEY, rhythm TEXT NOT NULL, ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS patch_patient (patch TEXT PRIMARY KEY, patient TEXT NOT NULL, wear_ms INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inv_demand (patch TEXT PRIMARY KEY, tenant TEXT NOT NULL, ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inv_demand_t ON inv_demand(tenant, ms);
";

pub const PO_FLOW: [&str; 6] = ["draft", "submitted", "confirmed", "shipped", "received", "cancelled"];
pub const REASONS: [&str; 6] = ["damaged", "expired", "returned", "lost", "count", "other"];

fn now() -> i64 {
    crate::protocol::now_ms() as i64
}

impl Inventory {
    pub fn open(db_path: &str) -> Arc<Inventory> {
        let db = Connection::open(db_path).unwrap_or_else(|_| Connection::open_in_memory().unwrap());
        let _ = db.execute_batch("PRAGMA busy_timeout=5000;");
        let _ = db.execute_batch(SCHEMA);
        // 계약·운영 설정, 발주 역할 기록, 출고 로트 줄, 방문 점검 기록 (기존 DB 는 열 추가)
        for sql in [
            "ALTER TABLE inv_policy ADD COLUMN model TEXT NOT NULL DEFAULT 'consign'",
            "ALTER TABLE inv_policy ADD COLUMN price REAL",
            "ALTER TABLE inv_policy ADD COLUMN count_days REAL NOT NULL DEFAULT 30",
            "ALTER TABLE inv_policy ADD COLUMN auto_req INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE inv_policy ADD COLUMN contract_end TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE inv_policy ADD COLUMN committed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE inv_po ADD COLUMN hospital_po TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE inv_po ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE inv_po ADD COLUMN shipped_by TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE inv_po ADD COLUMN received_by TEXT NOT NULL DEFAULT ''",
        ] { let _ = db.execute(sql, []); }
        let _ = db.execute_batch("CREATE TABLE IF NOT EXISTS inv_po_line (id INTEGER PRIMARY KEY AUTOINCREMENT, po INTEGER NOT NULL, lot TEXT NOT NULL, expiry TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL, recv_qty INTEGER);
            CREATE INDEX IF NOT EXISTS inv_po_line_po ON inv_po_line(po);
            CREATE TABLE IF NOT EXISTS inv_count (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, sku TEXT NOT NULL, ms INTEGER NOT NULL, by_user TEXT NOT NULL, book INTEGER NOT NULL, counted INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS inv_count_t ON inv_count(tenant, sku, ms);");
        // 기본 품목 하나 (처음 실행)
        let n: i64 = db.query_row("SELECT COUNT(*) FROM inv_sku", [], |r| r.get(0)).unwrap_or(0);
        if n == 0 {
            let _ = db.execute("INSERT INTO inv_sku (id, name, per_box, unit_price, wear_days) VALUES ('ECG-PATCH-14D', 'ECG 패치 14일형', 10, 0, 14)", []);
        }
        Arc::new(Inventory { db: Mutex::new(db), census: Mutex::new(Default::default()) })
    }

    fn on_hand(db: &Connection, tenant: &str, sku: &str, usable_only: bool) -> i64 {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let q = if usable_only { "SELECT COALESCE(SUM(qty),0) FROM inv_lot WHERE tenant=?1 AND sku=?2 AND qty>0 AND (expiry='' OR expiry>=?3)" } else { "SELECT COALESCE(SUM(qty),0) FROM inv_lot WHERE tenant=?1 AND sku=?2 AND qty>0 AND ?3=?3" };
        db.query_row(q, params![tenant, sku, today], |r| r.get(0)).unwrap_or(0)
    }

    /// 사용(차감): 유효기간이 먼저인 로트부터(FEFO). 모자라면 남은 만큼 음수 로트 없이 원장에만 '부족'으로 남긴다.
    fn consume_fefo(db: &Connection, tenant: &str, sku: &str, mut qty: i64, kind: &str, reason: &str, refx: &str, by: &str) -> i64 {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let lots: Vec<(i64, i64)> = db
            .prepare("SELECT id, qty FROM inv_lot WHERE tenant=?1 AND sku=?2 AND qty>0 AND (expiry='' OR expiry>=?3) ORDER BY CASE WHEN expiry='' THEN '9999' ELSE expiry END, received_ms")
            .and_then(|mut st| st.query_map(params![tenant, sku, today], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        let mut done = 0;
        for (id, q) in lots {
            if qty <= 0 { break; }
            let take = q.min(qty);
            let _ = db.execute("UPDATE inv_lot SET qty=qty-?1 WHERE id=?2", params![take, id]);
            let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![now(), tenant, sku, id, kind, -take, reason, refx, by]);
            qty -= take;
            done += take;
        }
        if qty > 0 {
            let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,NULL,?4,?5,'shortage',?6,?7)", params![now(), tenant, sku, kind, -qty, refx, by]);
        }
        done
    }

    /// 사이트 병원의 새 패치 부착 → 1개 자동 차감 (패치 번호당 한 번). 오래된 발급(7일 넘음)은 재고 이전 기록이라 세지 않는다.
    pub fn auto_consume(&self, tenant: &str, patch: &str, issued_ms: u64) {
        if tenant.is_empty() || crate::protocol::now_ms().saturating_sub(issued_ms) > 180 * 86_400_000 {
            return;
        }
        let db = self.db.lock().unwrap();
        // 수요 이력: 재고 시작 전 부착도 소비 패턴으로는 센다
        let _ = db.execute("INSERT OR IGNORE INTO inv_demand (patch, tenant, ms) VALUES (?1, ?2, ?3)", params![patch, tenant, issued_ms as i64]);
        if crate::protocol::now_ms().saturating_sub(issued_ms) > 7 * 86_400_000 { return; }
        // 재고 관리를 시작(이 병원의 첫 입고)하기 전에 붙인 패치는 세지 않는다 — 시작하자마자 기존 부착분이 한꺼번에 빠지지 않게
        let start: Option<i64> = db.query_row("SELECT MIN(received_ms) FROM inv_lot WHERE tenant=?1", params![tenant], |r| r.get(0)).ok().flatten();
        match start { Some(st) if issued_ms as i64 >= st => {} _ => return }
        let fresh = db.execute("INSERT OR IGNORE INTO inv_seen (patch, ms) VALUES (?1, ?2)", params![patch, issued_ms as i64]).unwrap_or(0) == 1;
        if !fresh { return; }
        let sku: String = db.query_row("SELECT id FROM inv_sku WHERE active=1 ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap_or_else(|_| "ECG-PATCH-14D".into());
        Self::consume_fefo(&db, tenant, &sku, 1, "use", "patch_attach", patch, "auto");
    }

    /// 패치별 마지막 환자 정보 (퇴원·패치 교체 뒤에도 전날 리포트에 환자를 표시하려고)
    pub fn save_patients(&self, rows: &[(String, String, u64)]) {
        let mut db = self.db.lock().unwrap();
        let tx = match db.transaction() { Ok(t) => t, Err(_) => return };
        {
            for (patch, pj, wear) in rows {
                let _ = tx.execute("INSERT INTO patch_patient (patch, patient, wear_ms, ms) VALUES (?1,?2,?3,?4) ON CONFLICT(patch) DO UPDATE SET patient=excluded.patient, wear_ms=excluded.wear_ms, ms=excluded.ms WHERE patch_patient.patient<>excluded.patient OR patch_patient.wear_ms<>excluded.wear_ms", params![patch, pj, *wear as i64, now()]);
            }
        }
        let _ = tx.commit();
    }
    /// 패치별 기저 리듬(에뮬레이터 정답) — 퇴원 뒤에도 정답지 리포트에 쓰려고 보관
    pub fn save_bases(&self, rows: &[(u32, String)]) {
        let mut db = self.db.lock().unwrap();
        let tx = match db.transaction() { Ok(t) => t, Err(_) => return };
        for (p, r) in rows { let _ = tx.execute("INSERT INTO patch_base (patch, rhythm, ms) VALUES (?1,?2,?3) ON CONFLICT(patch) DO UPDATE SET rhythm=excluded.rhythm, ms=excluded.ms WHERE patch_base.rhythm<>excluded.rhythm", params![*p as i64, r, now()]); }
        let _ = tx.commit();
    }
    pub fn base_of(&self, patch: u32) -> Option<String> {
        self.db.lock().unwrap().query_row("SELECT rhythm FROM patch_base WHERE patch=?1", params![patch as i64], |r| r.get(0)).ok()
    }

    /// 패치별 환자 정보·기저 리듬 보관 삭제 (가동 초기화). 재고 원장·로트·발주는 업무 기록이라 남긴다.
    pub fn clear_patient_data(&self) -> usize {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM patch_patient", []).unwrap_or(0) + db.execute("DELETE FROM patch_base", []).unwrap_or(0)
    }

    /// 데이터 시작 시각 이전에 마지막으로 바뀐 환자 보관 삭제 (지금 연결된 환자는 1분 안에 다시 채워진다)
    pub fn clear_patient_before(&self, ms: u64) -> usize {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM patch_patient WHERE ms < ?1", params![ms as i64]).unwrap_or(0) + db.execute("DELETE FROM patch_base WHERE ms < ?1", params![ms as i64]).unwrap_or(0)
    }

    pub fn patient_snapshot(&self, patch: &str) -> Option<(serde_json::Value, u64)> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT patient, wear_ms FROM patch_patient WHERE patch=?1", params![patch], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).ok()
            .and_then(|(p, w)| serde_json::from_str(&p).ok().map(|v| (v, w as u64)))
    }

    pub fn set_census(&self, tenant: &str, n: usize) { self.census.lock().unwrap().insert(tenant.to_string(), n); }

    /// 일별 수요 (오래된 것 → 어제, 최대 90일) — 사이트 병원은 부착 이력 + 수동 사용, 그 외는 사용 원장
    fn demand_history(db: &Connection, tenant: &str, sku: &str, from_demand: bool) -> Vec<f64> {
        let today0 = chrono::Local::now().date_naive().and_hms_opt(0, 0, 0).and_then(|d| d.and_local_timezone(chrono::Local).earliest()).map(|d| d.timestamp_millis()).unwrap_or(now());
        let since = today0 - 90 * 86_400_000;
        let mut ev: Vec<(i64, f64)> = Vec::new();
        if from_demand {
            if let Ok(mut st) = db.prepare("SELECT ms FROM inv_demand WHERE tenant=?1 AND ms>=?2 AND ms<?3") {
                if let Ok(rs) = st.query_map(params![tenant, since, today0], |r| r.get::<_, i64>(0)) { ev.extend(rs.flatten().map(|m| (m, 1.0))); }
            }
            if let Ok(mut st) = db.prepare("SELECT ms, -qty FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND kind='use' AND reason<>'patch_attach' AND ms>=?3 AND ms<?4") {
                if let Ok(rs) = st.query_map(params![tenant, sku, since, today0], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as f64))) { ev.extend(rs.flatten()); }
            }
        } else if let Ok(mut st) = db.prepare("SELECT ms, -qty FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND kind='use' AND ms>=?3 AND ms<?4") {
            if let Ok(rs) = st.query_map(params![tenant, sku, since, today0], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as f64))) { ev.extend(rs.flatten()); }
        }
        let Some(first) = ev.iter().map(|e| e.0).min() else { return Vec::new() };
        let days = (((today0 - first) / 86_400_000) + 1).clamp(1, 90) as usize;
        let start = today0 - days as i64 * 86_400_000;
        let mut y = vec![0f64; days];
        for (ms, q) in ev { let i = ((ms - start) / 86_400_000) as usize; if i < days { y[i] += q; } }
        y
    }

    /// 병원·품목별 상태와 보충 권장
    pub fn summary(&self, tenants: &[(String, String)]) -> serde_json::Value {
        let db = self.db.lock().unwrap();
        let skus: Vec<(String, String, i64, f64, f64)> = db.prepare("SELECT id, name, per_box, unit_price, wear_days FROM inv_sku WHERE active=1 ORDER BY id")
            .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect()).unwrap_or_default();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let soon = (chrono::Local::now() + chrono::Duration::days(60)).format("%Y-%m-%d").to_string();
        
        let mut rows = Vec::new();
        for (tid, tname) in tenants {
            for (sku, sname, per_box, price, _wear) in &skus {
                let (lead, review, service, min_boxes): (f64, f64, f64, i64) = db.query_row("SELECT lead_days, review_days, service, min_boxes FROM inv_policy WHERE tenant=?1 AND sku=?2", params![tid, sku], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap_or((7.0, 7.0, 0.95, 1));
                let (model, price_ovr, count_days, auto_req, contract_end, committed): (String, Option<f64>, f64, bool, String, i64) = db.query_row("SELECT model, price, count_days, auto_req, contract_end, committed FROM inv_policy WHERE tenant=?1 AND sku=?2", params![tid, sku], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? == 1, r.get(4)?, r.get(5)?))).unwrap_or(("consign".into(), None, 30.0, false, String::new(), 0));
                let price = &price_ovr.unwrap_or(*price);
                let last_count: Option<i64> = db.query_row("SELECT MAX(ms) FROM inv_count WHERE tenant=?1 AND sku=?2", params![tid, sku], |r| r.get(0)).ok().flatten();
                let unrecorded: i64 = db.query_row("SELECT COALESCE(-SUM(qty),0) FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND reason='shortage' AND ms>=?3", params![tid, sku, last_count.unwrap_or(0)], |r| r.get(0)).unwrap_or(0);
                let site_like = self.census.lock().unwrap().get(tid).copied();
                let has_demand = site_like.is_some() || db.query_row("SELECT EXISTS(SELECT 1 FROM inv_demand WHERE tenant=?1)", params![tid], |r| r.get::<_, i64>(0)).unwrap_or(0) == 1;
                let hist = Self::demand_history(&db, tid, sku, has_demand);
                let prior = site_like.filter(|n| *n > 0).map(|n| n as f64 / _wear.max(1.0));
                let fc = crate::inv_forecast::forecast(&hist, prior, 90);
                let z = if service >= 0.99 { 2.33 } else if service >= 0.975 { 1.96 } else if service >= 0.95 { 1.65 } else if service >= 0.9 { 1.28 } else { 0.84 };
                let sum_to = |days: f64| { let k = days.floor() as usize; fc.daily.iter().take(k).sum::<f64>() + fc.daily.get(k).copied().unwrap_or(0.0) * (days - k as f64) };
                let d = if fc.next30 > 0.0 { fc.next30 / 30.0 } else { 0.0 };
                let ss = (z * fc.sd * lead.max(0.0).sqrt()).ceil();
                let rop = (sum_to(lead) + ss).ceil();
                let par = (sum_to(lead + review) + ss).ceil();
                let used: f64 = hist.iter().rev().take(30).sum();
                let days = hist.len();
                let on_hand = Self::on_hand(&db, tid, sku, true);
                let expired = Self::on_hand(&db, tid, sku, false) - on_hand;
                let expiring: i64 = db.query_row("SELECT COALESCE(SUM(qty),0) FROM inv_lot WHERE tenant=?1 AND sku=?2 AND qty>0 AND expiry<>'' AND expiry>=?3 AND expiry<?4", params![tid, sku, today, soon], |r| r.get(0)).unwrap_or(0);
                // 입고 예정: 발주별 도착일(eta, 없으면 오늘+리드타임)
                let pos: Vec<(i64, String)> = db.prepare("SELECT boxes, eta FROM inv_po WHERE tenant=?1 AND sku=?2 AND status IN ('submitted','confirmed','shipped')")
                    .and_then(|mut st| st.query_map(params![tid, sku], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()).unwrap_or_default();
                let on_order_boxes: i64 = pos.iter().map(|p| p.0).sum();
                let po_open: std::collections::HashMap<String, i64> = db.prepare("SELECT status, COUNT(*) FROM inv_po WHERE tenant=?1 AND sku=?2 AND status IN ('draft','submitted','confirmed','shipped') GROUP BY status")
                    .and_then(|mut st| st.query_map(params![tid, sku], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect()).unwrap_or_default();
                let started: bool = db.query_row("SELECT COUNT(*) FROM inv_lot WHERE tenant=?1 AND sku=?2", params![tid, sku], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0;
                let on_order = on_order_boxes * per_box;
                let today_d = chrono::Local::now().date_naive();
                let arrivals: Vec<(usize, f64)> = pos.iter().map(|(bx, eta)| {
                    let day = chrono::NaiveDate::parse_from_str(eta, "%Y-%m-%d").ok().map(|e| (e - today_d).num_days().max(0) as usize).unwrap_or(lead.ceil() as usize);
                    (day, (*bx * per_box) as f64)
                }).collect();
                // 품절 예상일: 예측 수요로 하루씩 차감(입고 예정 반영)
                let mut stock = on_hand as f64;
                let mut stockout_day: Option<usize> = None;
                let mut stockout_no_order: Option<usize> = None;
                let mut bare = on_hand as f64;
                let mut projection: Vec<f64> = Vec::with_capacity(fc.daily.len());
                let mut arrive_days: Vec<(usize, f64)> = Vec::new();
                for (i, q) in fc.daily.iter().enumerate() {
                    for (dday, u) in &arrivals { if *dday == i { stock += u; arrive_days.push((i, *u)); } }
                    stock -= q; bare -= q;
                    projection.push((stock * 10.0).round() / 10.0);
                    if stockout_day.is_none() && stock < 0.0 { stockout_day = Some(i); }
                    if stockout_no_order.is_none() && bare < 0.0 { stockout_no_order = Some(i); }
                }
                let date_of = |i: usize| (today_d + chrono::Duration::days(i as i64)).format("%Y-%m-%d").to_string();
                let order_by = stockout_day.map(|i| date_of(i.saturating_sub(lead.ceil() as usize)));
                let need_more = |k: f64| (k - (on_hand + on_order) as f64).max(0.0).ceil();
                let need = (par - (on_hand + on_order) as f64).max(0.0);
                let mut boxes = (need / *per_box as f64).ceil() as i64;
                if boxes > 0 { boxes = boxes.max(min_boxes); }
                let status = if on_hand <= 0 { "stockout" } else if (on_hand as f64) <= rop && on_order == 0 { "reorder" } else if (on_hand as f64) <= rop { "on_order" } else { "ok" };
                let mut row = serde_json::json!({
                    "tenant": tid, "tenant_name": tname, "sku": sku, "sku_name": sname, "per_box": per_box, "unit_price": price,
                    "on_hand": on_hand, "expired": expired, "expiring_60d": expiring, "on_order": on_order, "on_order_boxes": on_order_boxes,
                    "avg_daily": (d * 100.0).round() / 100.0, "used_30d": used, "history_days": days, "sd_daily": fc.sd,
                    "lead_days": lead, "review_days": review, "service": service, "min_boxes": min_boxes,
                    "safety_stock": ss, "reorder_point": rop, "par": par, "dos": if d > 0.0 { Some(((on_hand as f64 / d) * 10.0).round() / 10.0) } else { None },
                    "suggest_boxes": boxes, "suggest_units": boxes * per_box, "suggest_amount": boxes as f64 * *per_box as f64 * price, "status": status,
                    "forecast": fc, "history": hist, "census": site_like, "po_open": po_open, "started": started, "projection": projection, "arrivals": arrive_days,
                    "stockout_date": stockout_day.map(date_of), "stockout_date_no_order": stockout_no_order.map(date_of), "order_by": order_by,
                    "need_more_30": need_more(sum_to(30.0)), "need_more_60": need_more(sum_to(60.0)), "need_more_90": need_more(sum_to(90.0)),
                });
                for (k, v) in [("model", serde_json::json!(model)), ("contract_end", serde_json::json!(contract_end)), ("committed", serde_json::json!(committed)), ("count_days", serde_json::json!(count_days)), ("auto_request", serde_json::json!(auto_req)), ("last_count_ms", serde_json::json!(last_count)), ("unrecorded_use", serde_json::json!(unrecorded))] { row[k] = v; }
                rows.push(row);
            }
        }
        serde_json::json!({ "rows": rows, "skus": skus.iter().map(|s| serde_json::json!({"id": s.0, "name": s.1, "per_box": s.2, "unit_price": s.3, "wear_days": s.4})).collect::<Vec<_>>(), "reasons": REASONS, "po_flow": PO_FLOW })
    }

    pub fn detail(&self, tenant: &str) -> serde_json::Value {
        let db = self.db.lock().unwrap();
        let lots: Vec<serde_json::Value> = db.prepare("SELECT id, sku, lot, expiry, qty, received_ms, po FROM inv_lot WHERE tenant=?1 AND qty>0 ORDER BY sku, CASE WHEN expiry='' THEN '9999' ELSE expiry END")
            .and_then(|mut st| st.query_map(params![tenant], |r| Ok(serde_json::json!({"id": r.get::<_, i64>(0)?, "sku": r.get::<_, String>(1)?, "lot": r.get::<_, String>(2)?, "expiry": r.get::<_, String>(3)?, "qty": r.get::<_, i64>(4)?, "received_ms": r.get::<_, i64>(5)?, "po": r.get::<_, Option<i64>>(6)?})))?.collect()).unwrap_or_default();
        let ledger: Vec<serde_json::Value> = db.prepare("SELECT l.ms, l.sku, COALESCE(t.lot,''), l.kind, l.qty, l.reason, l.ref, l.by_user FROM inv_ledger l LEFT JOIN inv_lot t ON t.id=l.lot WHERE l.tenant=?1 ORDER BY l.ms DESC LIMIT 300")
            .and_then(|mut st| st.query_map(params![tenant], |r| Ok(serde_json::json!({"ms": r.get::<_, i64>(0)?, "sku": r.get::<_, String>(1)?, "lot": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?, "qty": r.get::<_, i64>(4)?, "reason": r.get::<_, String>(5)?, "ref": r.get::<_, String>(6)?, "by": r.get::<_, String>(7)?})))?.collect()).unwrap_or_default();
        let pos: Vec<serde_json::Value> = db.prepare("SELECT id, sku, boxes, status, created_ms, updated_ms, by_user, tracking, note, eta, hospital_po, approved_by, shipped_by, received_by FROM inv_po WHERE tenant=?1 ORDER BY id DESC LIMIT 100")
            .and_then(|mut st| st.query_map(params![tenant], |r| Ok(serde_json::json!({"id": r.get::<_, i64>(0)?, "sku": r.get::<_, String>(1)?, "boxes": r.get::<_, i64>(2)?, "status": r.get::<_, String>(3)?, "created_ms": r.get::<_, i64>(4)?, "updated_ms": r.get::<_, i64>(5)?, "by": r.get::<_, String>(6)?, "tracking": r.get::<_, String>(7)?, "note": r.get::<_, String>(8)?, "eta": r.get::<_, String>(9)?, "hospital_po": r.get::<_, String>(10)?, "approved_by": r.get::<_, String>(11)?, "shipped_by": r.get::<_, String>(12)?, "received_by": r.get::<_, String>(13)?})))?.collect()).unwrap_or_default();
        let pos: Vec<serde_json::Value> = pos.into_iter().map(|mut p| { let id = p["id"].as_i64().unwrap_or(0); p["lines"] = serde_json::json!(Self::lines(&db, id)); p }).collect();
        let counts: Vec<serde_json::Value> = db.prepare("SELECT sku, ms, by_user, book, counted, note FROM inv_count WHERE tenant=?1 ORDER BY ms DESC LIMIT 20").and_then(|mut st| st.query_map(params![tenant], |r| Ok(serde_json::json!({"sku": r.get::<_, String>(0)?, "ms": r.get::<_, i64>(1)?, "by": r.get::<_, String>(2)?, "book": r.get::<_, i64>(3)?, "counted": r.get::<_, i64>(4)?, "note": r.get::<_, String>(5)?})))?.collect()).unwrap_or_default();
        // 일별 사용 (최근 30일) — 그래프
        let mut daily = vec![0i64; 30];
        if let Ok(mut st) = db.prepare("SELECT ms, -qty FROM inv_ledger WHERE tenant=?1 AND kind='use' AND ms>=?2") {
            if let Ok(rs) = st.query_map(params![tenant, now() - 30 * 86_400_000], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))) {
                for (ms, q) in rs.flatten() { let d = ((now() - ms) / 86_400_000).clamp(0, 29) as usize; daily[29 - d] += q; }
            }
        }
        serde_json::json!({ "tenant": tenant, "lots": lots, "ledger": ledger, "pos": pos, "daily_use": daily, "counts": counts })
    }

    pub fn upsert_sku(&self, id: &str, name: &str, per_box: i64, price: f64, wear: f64, active: bool) -> Result<(), String> {
        if id.trim().is_empty() || per_box <= 0 { return Err("품목 코드와 상자당 수량이 필요합니다".into()); }
        self.db.lock().unwrap().execute("INSERT INTO inv_sku (id, name, per_box, unit_price, wear_days, active) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, per_box=excluded.per_box, unit_price=excluded.unit_price, wear_days=excluded.wear_days, active=excluded.active", params![id.trim(), name, per_box, price, wear, active as i64]).map(|_| ()).map_err(|e| e.to_string())
    }
    pub fn set_policy(&self, tenant: &str, sku: &str, lead: f64, review: f64, service: f64, min_boxes: i64) -> Result<(), String> {
        if !(0.5..=0.999).contains(&service) || lead < 0.0 || review < 0.0 { return Err("값 범위를 확인하세요 (서비스수준 0.5–0.999)".into()); }
        self.db.lock().unwrap().execute("INSERT INTO inv_policy (tenant, sku, lead_days, review_days, service, min_boxes) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(tenant, sku) DO UPDATE SET lead_days=excluded.lead_days, review_days=excluded.review_days, service=excluded.service, min_boxes=excluded.min_boxes", params![tenant, sku, lead, review, service, min_boxes.max(0)]).map(|_| ()).map_err(|e| e.to_string())
    }
    pub fn receive(&self, tenant: &str, sku: &str, lot: &str, expiry: &str, qty: i64, po: Option<i64>, by: &str) -> Result<(), String> {
        if qty <= 0 || lot.trim().is_empty() { return Err("로트 번호와 수량(1 이상)이 필요합니다".into()); }
        if !expiry.is_empty() && chrono::NaiveDate::parse_from_str(expiry, "%Y-%m-%d").is_err() { return Err("유효기간은 YYYY-MM-DD".into()); }
        let db = self.db.lock().unwrap();
        db.execute("INSERT INTO inv_lot (tenant, sku, lot, expiry, qty, received_ms, po) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![tenant, sku, lot.trim(), expiry, qty, now(), po]).map_err(|e| e.to_string())?;
        let id = db.last_insert_rowid();
        let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'receive',?5,'',?6,?7)", params![now(), tenant, sku, id, qty, po.map(|p| format!("PO-{p}")).unwrap_or_default(), by]);
        if let Some(p) = po { let _ = db.execute("UPDATE inv_po SET status='received', updated_ms=?1 WHERE id=?2 AND tenant=?3", params![now(), p, tenant]); }
        Ok(())
    }
    /// 수동 사용(+) / 조정(±, 사유 필수) / 실사(센 수량)
    pub fn adjust(&self, tenant: &str, sku: &str, kind: &str, qty: i64, reason: &str, lot: Option<i64>, by: &str) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        match kind {
            "use" => { if qty <= 0 { return Err("사용 수량은 1 이상".into()); } Self::consume_fefo(&db, tenant, sku, qty, "use", "manual", "", by); }
            "adjust" => {
                if !REASONS.contains(&reason) { return Err("조정 사유 코드가 필요합니다".into()); }
                if qty < 0 {
                    match lot {
                        Some(id) => { let _ = db.execute("UPDATE inv_lot SET qty=MAX(0, qty+?1) WHERE id=?2 AND tenant=?3", params![qty, id, tenant]); let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,?6,?7)", params![now(), tenant, sku, id, qty, reason, by]); }
                        None => { Self::consume_fefo(&db, tenant, sku, -qty, "adjust", reason, "", by); }
                    }
                } else if qty > 0 {
                    db.execute("INSERT INTO inv_lot (tenant, sku, lot, expiry, qty, received_ms) VALUES (?1,?2,'ADJ','',?3,?4)", params![tenant, sku, qty, now()]).map_err(|e| e.to_string())?;
                    let id = db.last_insert_rowid();
                    let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,?6,?7)", params![now(), tenant, sku, id, qty, reason, by]);
                }
            }
            "count" => {
                if qty < 0 { return Err("센 수량은 0 이상".into()); }
                let cur = Self::on_hand(&db, tenant, sku, true);
                let diff = qty - cur;
                if diff < 0 { Self::consume_fefo(&db, tenant, sku, -diff, "adjust", "count", &format!("실사 {qty}"), by); }
                else if diff > 0 {
                    let _ = db.execute("INSERT INTO inv_lot (tenant, sku, lot, expiry, qty, received_ms) VALUES (?1,?2,'COUNT','',?3,?4)", params![tenant, sku, diff, now()]);
                    let id = db.last_insert_rowid();
                    let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,'count',?6,?7)", params![now(), tenant, sku, id, diff, format!("실사 {qty}"), by]);
                } else {
                    let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,'count',0,'count',?4,?5)", params![now(), tenant, sku, format!("실사 {qty} 일치"), by]);
                }
            }
            _ => return Err("kind 는 use | adjust | count".into()),
        }
        Ok(())
    }
    pub fn po_create(&self, tenant: &str, sku: &str, boxes: i64, note: &str, by: &str) -> Result<i64, String> {
        if boxes <= 0 { return Err("상자 수는 1 이상".into()); }
        let db = self.db.lock().unwrap();
        db.execute("INSERT INTO inv_po (tenant, sku, boxes, status, created_ms, updated_ms, by_user, note) VALUES (?1,?2,?3,'submitted',?4,?4,?5,?6)", params![tenant, sku, boxes, now(), by, note]).map_err(|e| e.to_string())?;
        Ok(db.last_insert_rowid())
    }
    pub fn po_update(&self, tenant: &str, id: i64, status: &str, tracking: &str, eta: &str, boxes: Option<i64>) -> Result<(), String> {
        if !PO_FLOW.contains(&status) || status == "received" { return Err("상태는 draft|submitted|confirmed|shipped|cancelled (입고는 '입고' 로)".into()); }
        let db = self.db.lock().unwrap();
        let cur: String = db.query_row("SELECT status FROM inv_po WHERE id=?1 AND tenant=?2", params![id, tenant], |r| r.get(0)).map_err(|_| "발주를 찾을 수 없습니다".to_string())?;
        let rank = |s: &str| PO_FLOW.iter().position(|x| *x == s).unwrap_or(0);
        if cur == "received" || cur == "cancelled" { return Err(format!("이미 {cur} 상태입니다")); }
        if status != "cancelled" && rank(status) < rank(&cur) { return Err("이전 단계로 되돌릴 수 없습니다".into()); }
        db.execute("UPDATE inv_po SET status=?1, tracking=CASE WHEN ?2<>'' THEN ?2 ELSE tracking END, eta=CASE WHEN ?3<>'' THEN ?3 ELSE eta END, boxes=COALESCE(?4, boxes), updated_ms=?5 WHERE id=?6 AND tenant=?7", params![status, tracking, eta, boxes, now(), id, tenant]).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[derive(serde::Deserialize, Clone)]
pub struct ShipLine { pub lot: String, #[serde(default)] pub expiry: String, pub qty: i64 }
#[derive(serde::Deserialize, Clone)]
pub struct LotCount { pub lot_id: i64, pub counted: i64, #[serde(default)] pub action: String }

impl Inventory {
    fn lines(db: &Connection, po: i64) -> Vec<serde_json::Value> {
        db.prepare("SELECT id, lot, expiry, qty, recv_qty FROM inv_po_line WHERE po=?1 ORDER BY id")
            .and_then(|mut st| st.query_map(params![po], |r| Ok(serde_json::json!({"id": r.get::<_, i64>(0)?, "lot": r.get::<_, String>(1)?, "expiry": r.get::<_, String>(2)?, "qty": r.get::<_, i64>(3)?, "recv_qty": r.get::<_, Option<i64>>(4)?})))?.collect()).unwrap_or_default()
    }
    fn po_status(db: &Connection, tenant: &str, id: i64) -> Result<(String, String, i64), String> {
        db.query_row("SELECT status, sku, boxes FROM inv_po WHERE id=?1 AND tenant=?2", params![id, tenant], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|_| "발주를 찾을 수 없습니다".to_string())
    }
    /// 계약·운영 설정 (공급사)
    #[allow(clippy::too_many_arguments)]
    pub fn set_contract(&self, tenant: &str, sku: &str, model: &str, price: Option<f64>, count_days: f64, auto_req: bool, contract_end: &str, committed: i64) -> Result<(), String> {
        if !matches!(model, "consign" | "purchase") { return Err("운영 방식은 위탁(consign) 또는 구매(purchase)".into()); }
        if !contract_end.is_empty() && chrono::NaiveDate::parse_from_str(contract_end, "%Y-%m-%d").is_err() { return Err("계약 종료일은 YYYY-MM-DD".into()); }
        let db = self.db.lock().unwrap();
        db.execute("INSERT INTO inv_policy (tenant, sku) VALUES (?1, ?2) ON CONFLICT(tenant, sku) DO NOTHING", params![tenant, sku]).map_err(|e| e.to_string())?;
        db.execute("UPDATE inv_policy SET model=?3, price=?4, count_days=?5, auto_req=?6, contract_end=?7, committed=?8 WHERE tenant=?1 AND sku=?2", params![tenant, sku, model, price, count_days.max(1.0), auto_req as i64, contract_end, committed.max(0)]).map(|_| ()).map_err(|e| e.to_string())
    }
    /// 병원 승인: 요청 → 승인 (병원 발주번호)
    pub fn po_approve(&self, tenant: &str, id: i64, hospital_po: &str, by: &str) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        let (st, _, _) = Self::po_status(&db, tenant, id)?;
        if st != "submitted" && st != "draft" { return Err(format!("승인할 수 없는 상태입니다 ({st})")); }
        db.execute("UPDATE inv_po SET status='confirmed', hospital_po=?1, approved_by=?2, updated_ms=?3 WHERE id=?4 AND tenant=?5", params![hospital_po.trim(), by, now(), id, tenant]).map(|_| ()).map_err(|e| e.to_string())
    }
    /// 출고: 로트·유효기간·수량 줄 + 송장. 승인 전 출고는 막는다(병원 승인 필요)
    pub fn po_ship(&self, tenant: &str, id: i64, lines: &[ShipLine], tracking: &str, eta: &str, by: &str) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        let (st, _, _) = Self::po_status(&db, tenant, id)?;
        if st != "confirmed" { return Err("병원 승인 후에 출고할 수 있습니다".into()); }
        if lines.is_empty() || lines.iter().any(|l| l.qty <= 0 || l.lot.trim().is_empty()) { return Err("출고 줄마다 로트 번호와 수량(1 이상)이 필요합니다".into()); }
        for l in lines { if !l.expiry.is_empty() && chrono::NaiveDate::parse_from_str(&l.expiry, "%Y-%m-%d").is_err() { return Err(format!("유효기간 형식 오류: {}", l.expiry)); } }
        if !eta.is_empty() && chrono::NaiveDate::parse_from_str(eta, "%Y-%m-%d").is_err() { return Err("도착 예정일은 YYYY-MM-DD".into()); }
        let _ = db.execute("DELETE FROM inv_po_line WHERE po=?1", params![id]);
        for l in lines { db.execute("INSERT INTO inv_po_line (po, lot, expiry, qty) VALUES (?1,?2,?3,?4)", params![id, l.lot.trim(), l.expiry, l.qty]).map_err(|e| e.to_string())?; }
        db.execute("UPDATE inv_po SET status='shipped', tracking=?1, eta=?2, shipped_by=?3, updated_ms=?4 WHERE id=?5 AND tenant=?6", params![tracking, eta, by, now(), id, tenant]).map(|_| ()).map_err(|e| e.to_string())
    }
    /// 병원 수령 확인: 줄별 받은 수량(기본 = 출고 수량) → 로트 생성, 차이는 원장에 남긴다
    pub fn po_receive(&self, tenant: &str, id: i64, recv: &std::collections::HashMap<i64, i64>, by: &str) -> Result<i64, String> {
        let db = self.db.lock().unwrap();
        let (st, sku, _) = Self::po_status(&db, tenant, id)?;
        if st != "shipped" { return Err("출고된 발주만 수령 확인할 수 있습니다".into()); }
        let lines: Vec<(i64, String, String, i64)> = db.prepare("SELECT id, lot, expiry, qty FROM inv_po_line WHERE po=?1").and_then(|mut s| s.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect()).unwrap_or_default();
        let mut total = 0;
        for (lid, lot, exp, qty) in lines {
            let got = recv.get(&lid).copied().unwrap_or(qty).max(0);
            let _ = db.execute("UPDATE inv_po_line SET recv_qty=?1 WHERE id=?2", params![got, lid]);
            if got > 0 {
                db.execute("INSERT INTO inv_lot (tenant, sku, lot, expiry, qty, received_ms, po) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![tenant, sku, lot, exp, got, now(), id]).map_err(|e| e.to_string())?;
                let lot_id = db.last_insert_rowid();
                let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'receive',?5,'',?6,?7)", params![now(), tenant, sku, lot_id, got, format!("PO-{id}"), by]);
            }
            if got != qty {
                let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,'count',0,'receive_diff',?4,?5)", params![now(), tenant, sku, format!("PO-{id} {lot}: 출고 {qty} / 수령 {got}"), by]);
            }
            total += got;
        }
        db.execute("UPDATE inv_po SET status='received', received_by=?1, updated_ms=?2 WHERE id=?3 AND tenant=?4", params![by, now(), id, tenant]).map_err(|e| e.to_string())?;
        Ok(total)
    }
    /// 작성/요청 단계 발주 삭제
    pub fn po_delete(&self, tenant: &str, id: i64) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        let (st, _, _) = Self::po_status(&db, tenant, id)?;
        if st != "draft" && st != "submitted" { return Err("요청 단계까지만 지울 수 있습니다 (그 뒤는 취소)".into()); }
        db.execute("DELETE FROM inv_po WHERE id=?1 AND tenant=?2", params![id, tenant]).map(|_| ()).map_err(|e| e.to_string())
    }
    /// 방문 점검: 로트별로 센 수량 → 차이 조정 + 조치(폐기·반품), 점검 기록
    pub fn visit_count(&self, tenant: &str, sku: &str, counts: &[LotCount], extra_found: i64, note: &str, by: &str) -> Result<serde_json::Value, String> {
        let db = self.db.lock().unwrap();
        let book = Self::on_hand(&db, tenant, sku, false);
        let mut counted_total = 0;
        for c in counts {
            if c.counted < 0 { return Err("센 수량은 0 이상".into()); }
            let (cur, lot_sku): (i64, String) = db.query_row("SELECT qty, sku FROM inv_lot WHERE id=?1 AND tenant=?2", params![c.lot_id, tenant], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| format!("로트 {} 없음", c.lot_id))?;
            if lot_sku != sku { continue }
            let diff = c.counted - cur;
            if diff != 0 {
                let _ = db.execute("UPDATE inv_lot SET qty=?1 WHERE id=?2", params![c.counted, c.lot_id]);
                let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,'count','방문 점검',?6)", params![now(), tenant, sku, c.lot_id, diff, by]);
            }
            counted_total += c.counted;
            // 조치: 폐기·반품은 센 수량 전부를 뺀다
            if (c.action == "discard" || c.action == "return") && c.counted > 0 {
                let _ = db.execute("UPDATE inv_lot SET qty=0 WHERE id=?1", params![c.lot_id]);
                let reason = if c.action == "discard" { "expired" } else { "returned" };
                let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,?6,'방문 점검',?7)", params![now(), tenant, sku, c.lot_id, -c.counted, reason, by]);
            }
        }
        if extra_found > 0 {
            db.execute("INSERT INTO inv_lot (tenant, sku, lot, expiry, qty, received_ms) VALUES (?1,?2,'FOUND','',?3,?4)", params![tenant, sku, extra_found, now()]).map_err(|e| e.to_string())?;
            let id = db.last_insert_rowid();
            let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,'count','방문 점검: 기록 없는 재고',?6)", params![now(), tenant, sku, id, extra_found, by]);
            counted_total += extra_found;
        }
        db.execute("INSERT INTO inv_count (tenant, sku, ms, by_user, book, counted, note) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![tenant, sku, now(), by, book, counted_total, note]).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "book": book, "counted": counted_total, "diff": counted_total - book }))
    }
    /// 병원 간 이동 (유효기간 임박분 돌려쓰기 등): 같은 로트·유효기간으로 옮긴다
    pub fn transfer(&self, from: &str, to: &str, lot_id: i64, qty: i64, by: &str) -> Result<(), String> {
        if from == to || qty <= 0 { return Err("다른 병원과 1 이상 수량이 필요합니다".into()); }
        let db = self.db.lock().unwrap();
        let (sku, lot, exp, cur): (String, String, String, i64) = db.query_row("SELECT sku, lot, expiry, qty FROM inv_lot WHERE id=?1 AND tenant=?2", params![lot_id, from], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|_| "로트를 찾을 수 없습니다".to_string())?;
        if qty > cur { return Err(format!("로트 잔량({cur})보다 많습니다")); }
        db.execute("UPDATE inv_lot SET qty=qty-?1 WHERE id=?2", params![qty, lot_id]).map_err(|e| e.to_string())?;
        let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'adjust',?5,'transfer_out',?6,?7)", params![now(), from, sku, lot_id, -qty, format!("→ {to}"), by]);
        db.execute("INSERT INTO inv_lot (tenant, sku, lot, expiry, qty, received_ms) VALUES (?1,?2,?3,?4,?5,?6)", params![to, sku, lot, exp, qty, now()]).map_err(|e| e.to_string())?;
        let nid = db.last_insert_rowid();
        let _ = db.execute("INSERT INTO inv_ledger (ms, tenant, sku, lot, kind, qty, reason, ref, by_user) VALUES (?1,?2,?3,?4,'receive',?5,'transfer_in',?6,?7)", params![now(), to, sku, nid, qty, format!("← {from}"), by]);
        Ok(())
    }
    /// 월 사용 명세 (위탁: 사용분 청구 근거 / 구매: 사용 보고)
    pub fn statement(&self, tenant: &str, month: &str) -> Result<serde_json::Value, String> {
        let first = chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").map_err(|_| "월은 YYYY-MM".to_string())?;
        let next = if first.month() == 12 { chrono::NaiveDate::from_ymd_opt(first.year() + 1, 1, 1) } else { chrono::NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1) }.unwrap();
        let ms = |d: chrono::NaiveDate| d.and_hms_opt(0, 0, 0).and_then(|x| x.and_local_timezone(chrono::Local).earliest()).map(|x| x.timestamp_millis()).unwrap_or(0);
        let db = self.db.lock().unwrap();
        let mut out = Vec::new();
        let skus: Vec<(String, String, f64)> = db.prepare("SELECT id, name, unit_price FROM inv_sku ORDER BY id").and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()).unwrap_or_default();
        for (sku, name, base) in skus {
            let price: f64 = db.query_row("SELECT price FROM inv_policy WHERE tenant=?1 AND sku=?2", params![tenant, sku], |r| r.get::<_, Option<f64>>(0)).ok().flatten().unwrap_or(base);
            let model: String = db.query_row("SELECT model FROM inv_policy WHERE tenant=?1 AND sku=?2", params![tenant, sku], |r| r.get(0)).unwrap_or_else(|_| "consign".into());
            let mut by_day: std::collections::BTreeMap<String, i64> = Default::default();
            if let Ok(mut st) = db.prepare("SELECT ms, -qty FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND kind='use' AND ms>=?3 AND ms<?4") {
                if let Ok(rs) = st.query_map(params![tenant, sku, ms(first), ms(next)], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))) {
                    for (t, q) in rs.flatten() { *by_day.entry(chrono::Local.timestamp_millis_opt(t).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()).or_default() += q; }
                }
            }
            let received: i64 = db.query_row("SELECT COALESCE(SUM(qty),0) FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND kind='receive' AND reason<>'transfer_in' AND ms>=?3 AND ms<?4", params![tenant, sku, ms(first), ms(next)], |r| r.get(0)).unwrap_or(0);
            let used: i64 = by_day.values().sum();
            if used == 0 && received == 0 { continue }
            let billable = if model == "consign" { used } else { received };
            out.push(serde_json::json!({ "sku": sku, "name": name, "model": model, "unit_price": price, "used": used, "received": received, "billable": billable, "amount": billable as f64 * price, "days": by_day }));
        }
        Ok(serde_json::json!({ "tenant": tenant, "month": month, "lines": out }))
    }
    /// 로트 추적 (리콜): 어느 병원에 얼마 남았고 언제 들어갔나
    pub fn lot_trace(&self, lot: &str, tenants: &[String]) -> serde_json::Value {
        let db = self.db.lock().unwrap();
        let rows: Vec<serde_json::Value> = db.prepare("SELECT id, tenant, sku, lot, expiry, qty, received_ms, po FROM inv_lot WHERE lot=?1 ORDER BY tenant").and_then(|mut st| st.query_map(params![lot.trim()], |r| Ok(serde_json::json!({"id": r.get::<_, i64>(0)?, "tenant": r.get::<_, String>(1)?, "sku": r.get::<_, String>(2)?, "lot": r.get::<_, String>(3)?, "expiry": r.get::<_, String>(4)?, "qty": r.get::<_, i64>(5)?, "received_ms": r.get::<_, i64>(6)?, "po": r.get::<_, Option<i64>>(7)?})))?.collect()).unwrap_or_default();
        let rows: Vec<serde_json::Value> = rows.into_iter().filter(|r| tenants.iter().any(|t| r["tenant"] == t.as_str())).collect();
        serde_json::json!({ "lot": lot, "rows": rows })
    }
    /// 자동 발주 요청: 설정이 켜진 병원·품목이 발주 시점 아래이고 진행 중 발주가 없으면 요청을 만든다
    pub fn auto_requests(&self, tenants: &[(String, String)]) -> Vec<(String, String, i64)> {
        let sum = self.summary(tenants);
        let mut made = Vec::new();
        for r in sum["rows"].as_array().cloned().unwrap_or_default() {
            if r["auto_request"] != true || r["started"] != true { continue }
            let open: i64 = r["po_open"].as_object().map(|o| o.values().filter_map(|v| v.as_i64()).sum()).unwrap_or(0);
            let need = r["status"] == "reorder" || r["status"] == "stockout";
            let boxes = r["suggest_boxes"].as_i64().unwrap_or(0);
            if need && open == 0 && boxes > 0 {
                let (t, k) = (r["tenant"].as_str().unwrap_or(""), r["sku"].as_str().unwrap_or(""));
                if let Ok(id) = self.po_create(t, k, boxes, "자동 발주 요청 (발주 시점 도달)", "auto") { made.push((t.to_string(), k.to_string(), id)); }
            }
        }
        made
    }
}

/// 감시: 패치 발급 시각을 주기적으로 훑어 새 부착을 차감 (사이트 병원)
pub async fn run(state: Arc<AppState>) {
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let mut tick: u64 = 0;
    loop {
        let site = state.auth.site_tenant();
        let mut issued: Vec<(String, u64)> = Vec::new();
        let mut census = 0usize;
        let mut snaps: Vec<(String, String, u64)> = Vec::new();
        state.registry.for_each(|id, ch| {
            if let Some(p) = &ch.patient { census += 1; if let Ok(j) = serde_json::to_string(p) { snaps.push((id.to_string(), j, ch.wear_start_ms())); } }
            if ch.patch_issued_ms > 0 { issued.push((id.to_string(), ch.patch_issued_ms)) }
        });
        state.inventory.set_census(&site, census);
        { let inv = state.inventory.clone(); let _ = tokio::task::spawn_blocking(move || inv.save_patients(&snaps)).await; }
        let inv = state.inventory.clone();
        let _ = tokio::task::spawn_blocking(move || for (p, ms) in issued { inv.auto_consume(&site, &p, ms) }).await;
        tick += 1;
        if tick % 10 == 1 {
            let tenants: Vec<(String, String)> = state.auth.tenants().into_iter().map(|t| (t.id, t.name)).collect();
            let inv = state.inventory.clone();
            let st = state.clone();
            let _ = tokio::task::spawn_blocking(move || for (t, k, id) in inv.auto_requests(&tenants) { st.auth.audit("auto", &t, "inv_po_auto", &format!("PO-{id} {k}")) }).await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}
