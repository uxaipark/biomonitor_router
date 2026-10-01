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
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};

pub struct Inventory {
    db: Mutex<Connection>,
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
        // 기본 품목 하나 (처음 실행)
        let n: i64 = db.query_row("SELECT COUNT(*) FROM inv_sku", [], |r| r.get(0)).unwrap_or(0);
        if n == 0 {
            let _ = db.execute("INSERT INTO inv_sku (id, name, per_box, unit_price, wear_days) VALUES ('ECG-PATCH-14D', 'ECG 패치 14일형', 10, 0, 14)", []);
        }
        Arc::new(Inventory { db: Mutex::new(db) })
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
        if tenant.is_empty() || crate::protocol::now_ms().saturating_sub(issued_ms) > 7 * 86_400_000 {
            return;
        }
        let db = self.db.lock().unwrap();
        // 재고 관리를 시작(이 병원의 첫 입고)하기 전에 붙인 패치는 세지 않는다 — 시작하자마자 기존 부착분이 한꺼번에 빠지지 않게
        let start: Option<i64> = db.query_row("SELECT MIN(received_ms) FROM inv_lot WHERE tenant=?1", params![tenant], |r| r.get(0)).ok().flatten();
        match start { Some(st) if issued_ms as i64 >= st => {} _ => return }
        let fresh = db.execute("INSERT OR IGNORE INTO inv_seen (patch, ms) VALUES (?1, ?2)", params![patch, issued_ms as i64]).unwrap_or(0) == 1;
        if !fresh { return; }
        let sku: String = db.query_row("SELECT id FROM inv_sku WHERE active=1 ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap_or_else(|_| "ECG-PATCH-14D".into());
        Self::consume_fefo(&db, tenant, &sku, 1, "use", "patch_attach", patch, "auto");
    }

    /// 병원·품목별 상태와 보충 권장
    pub fn summary(&self, tenants: &[(String, String)]) -> serde_json::Value {
        let db = self.db.lock().unwrap();
        let skus: Vec<(String, String, i64, f64, f64)> = db.prepare("SELECT id, name, per_box, unit_price, wear_days FROM inv_sku WHERE active=1 ORDER BY id")
            .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect()).unwrap_or_default();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let soon = (chrono::Local::now() + chrono::Duration::days(60)).format("%Y-%m-%d").to_string();
        let since = now() - 30 * 86_400_000;
        let mut rows = Vec::new();
        for (tid, tname) in tenants {
            for (sku, sname, per_box, price, _wear) in &skus {
                let (lead, review, service, min_boxes): (f64, f64, f64, i64) = db.query_row("SELECT lead_days, review_days, service, min_boxes FROM inv_policy WHERE tenant=?1 AND sku=?2", params![tid, sku], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap_or((7.0, 7.0, 0.95, 1));
                // 일별 사용량 (최근 30일, 사용 kind 만)
                let mut daily = vec![0f64; 30];
                if let Ok(mut st) = db.prepare("SELECT ms, -qty FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND kind='use' AND ms>=?3") {
                    if let Ok(rs) = st.query_map(params![tid, sku, since], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))) {
                        for (ms, q) in rs.flatten() { let d = ((now() - ms) / 86_400_000).clamp(0, 29) as usize; daily[d] += q as f64; }
                    }
                }
                // 이력이 30일보다 짧으면 있는 날만으로 평균 (첫 사용일부터)
                let first_use: Option<i64> = db.query_row("SELECT MIN(ms) FROM inv_ledger WHERE tenant=?1 AND sku=?2 AND kind='use'", params![tid, sku], |r| r.get(0)).ok().flatten();
                let days = first_use.map(|f| (((now() - f) / 86_400_000) + 1).clamp(1, 30) as usize).unwrap_or(30);
                let used: f64 = daily[..days].iter().sum();
                let d = used / days as f64;
                let var = daily[..days].iter().map(|x| (x - d).powi(2)).sum::<f64>() / days.max(2).saturating_sub(1) as f64;
                let z = if service >= 0.99 { 2.33 } else if service >= 0.975 { 1.96 } else if service >= 0.95 { 1.65 } else if service >= 0.9 { 1.28 } else { 0.84 };
                let ss = (z * var.sqrt() * lead.sqrt()).ceil();
                let rop = (d * lead + ss).ceil();
                let par = (d * (lead + review) + ss).ceil();
                let on_hand = Self::on_hand(&db, tid, sku, true);
                let expired = Self::on_hand(&db, tid, sku, false) - on_hand;
                let expiring: i64 = db.query_row("SELECT COALESCE(SUM(qty),0) FROM inv_lot WHERE tenant=?1 AND sku=?2 AND qty>0 AND expiry<>'' AND expiry>=?3 AND expiry<?4", params![tid, sku, today, soon], |r| r.get(0)).unwrap_or(0);
                let on_order_boxes: i64 = db.query_row("SELECT COALESCE(SUM(boxes),0) FROM inv_po WHERE tenant=?1 AND sku=?2 AND status IN ('submitted','confirmed','shipped')", params![tid, sku], |r| r.get(0)).unwrap_or(0);
                let on_order = on_order_boxes * per_box;
                let need = (par - (on_hand + on_order) as f64).max(0.0);
                let mut boxes = (need / *per_box as f64).ceil() as i64;
                if boxes > 0 { boxes = boxes.max(min_boxes); }
                let status = if on_hand <= 0 { "stockout" } else if (on_hand as f64) <= rop && on_order == 0 { "reorder" } else if (on_hand as f64) <= rop { "on_order" } else { "ok" };
                rows.push(serde_json::json!({
                    "tenant": tid, "tenant_name": tname, "sku": sku, "sku_name": sname, "per_box": per_box, "unit_price": price,
                    "on_hand": on_hand, "expired": expired, "expiring_60d": expiring, "on_order": on_order, "on_order_boxes": on_order_boxes,
                    "avg_daily": (d * 100.0).round() / 100.0, "used_30d": used, "history_days": days, "sd_daily": (var.sqrt() * 100.0).round() / 100.0,
                    "lead_days": lead, "review_days": review, "service": service, "min_boxes": min_boxes,
                    "safety_stock": ss, "reorder_point": rop, "par": par, "dos": if d > 0.0 { Some(((on_hand as f64 / d) * 10.0).round() / 10.0) } else { None },
                    "suggest_boxes": boxes, "suggest_units": boxes * per_box, "suggest_amount": boxes as f64 * *per_box as f64 * price, "status": status,
                }));
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
        let pos: Vec<serde_json::Value> = db.prepare("SELECT id, sku, boxes, status, created_ms, updated_ms, by_user, tracking, note, eta FROM inv_po WHERE tenant=?1 ORDER BY id DESC LIMIT 100")
            .and_then(|mut st| st.query_map(params![tenant], |r| Ok(serde_json::json!({"id": r.get::<_, i64>(0)?, "sku": r.get::<_, String>(1)?, "boxes": r.get::<_, i64>(2)?, "status": r.get::<_, String>(3)?, "created_ms": r.get::<_, i64>(4)?, "updated_ms": r.get::<_, i64>(5)?, "by": r.get::<_, String>(6)?, "tracking": r.get::<_, String>(7)?, "note": r.get::<_, String>(8)?, "eta": r.get::<_, String>(9)?})))?.collect()).unwrap_or_default();
        // 일별 사용 (최근 30일) — 그래프
        let mut daily = vec![0i64; 30];
        if let Ok(mut st) = db.prepare("SELECT ms, -qty FROM inv_ledger WHERE tenant=?1 AND kind='use' AND ms>=?2") {
            if let Ok(rs) = st.query_map(params![tenant, now() - 30 * 86_400_000], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))) {
                for (ms, q) in rs.flatten() { let d = ((now() - ms) / 86_400_000).clamp(0, 29) as usize; daily[29 - d] += q; }
            }
        }
        serde_json::json!({ "tenant": tenant, "lots": lots, "ledger": ledger, "pos": pos, "daily_use": daily })
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
        db.execute("INSERT INTO inv_po (tenant, sku, boxes, status, created_ms, updated_ms, by_user, note) VALUES (?1,?2,?3,'draft',?4,?4,?5,?6)", params![tenant, sku, boxes, now(), by, note]).map_err(|e| e.to_string())?;
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

/// 감시: 패치 발급 시각을 주기적으로 훑어 새 부착을 차감 (사이트 병원)
pub async fn run(state: Arc<AppState>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let site = state.auth.site_tenant();
        let mut issued: Vec<(String, u64)> = Vec::new();
        state.registry.for_each(|id, ch| if ch.patch_issued_ms > 0 { issued.push((id.to_string(), ch.patch_issued_ms)) });
        let inv = state.inventory.clone();
        let _ = tokio::task::spawn_blocking(move || for (p, ms) in issued { inv.auto_consume(&site, &p, ms) }).await;
    }
}
