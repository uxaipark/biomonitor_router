use crate::protocol::Patient;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use tracing::{info, warn};

/// 그룹 정의.
/// - criteria: 속성 조건 (키: building/floor/ward/zone/room/doctor/department/nurse,
///   값: 허용 값 리스트 = OR, 키 간에는 AND)
/// - include/exclude: 채널 ID 수동 오버라이드 (exclude 최우선)
/// - criteria 와 include 가 모두 비어 있으면 전체 채널 매칭
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupConfig {
    pub id: String,
    pub name: String,
    /// 그룹 설명/메모 (어드민 목록에 표시)
    #[serde(default)]
    pub description: String,
    /// 작성자 (어드민에서 입력)
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub criteria: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    /// DB 기록 시각 (ms) — 어드민 표시용, 클라이언트가 보내는 값은 무시
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

fn patient_attr<'a>(p: &'a Patient, key: &str) -> Option<&'a str> {
    Some(match key {
        "building" => &p.building,
        "floor" => &p.floor,
        "ward" => &p.ward,
        "zone" => &p.zone,
        "room" => &p.room,
        "doctor" => &p.doctor,
        "department" => &p.department,
        "nurse" => &p.nurse,
        "diagnosis" => &p.diagnosis,
        "mode" => &p.mode,
        "home_region" => &p.home_region,
        _ => return None,
    })
}

impl GroupConfig {
    pub fn matches(&self, channel_id: &str, patient: Option<&Patient>) -> bool {
        if self.exclude.iter().any(|c| c == channel_id) {
            return false;
        }
        if self.include.iter().any(|c| c == channel_id) {
            return true;
        }
        if self.criteria.is_empty() {
            // include 만 있는 그룹은 include 멤버로 한정, 완전히 빈 그룹은 catch-all
            return self.include.is_empty();
        }
        let Some(p) = patient else { return false };
        self.criteria.iter().all(|(key, allowed)| {
            patient_attr(p, key)
                .map(|v| allowed.iter().any(|a| a == v))
                .unwrap_or(false)
        })
    }
}

/// 그룹 저장소. 라우터 로컬 SQLite(`ROUTER_DB_PATH`, 표 `groups`)에 영속화하고 메모리 사본으로 조회한다.
/// DB 가 비어 있으면 예전 `groups.json` 을 1회 가져오고, 그것도 없으면 기본 그룹을 만든다.
pub struct GroupStore {
    groups: RwLock<HashMap<String, GroupConfig>>,
    db: Mutex<rusqlite::Connection>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    criteria TEXT NOT NULL DEFAULT '{}',
    include TEXT NOT NULL DEFAULT '[]',
    exclude TEXT NOT NULL DEFAULT '[]',
    created_ms INTEGER NOT NULL DEFAULT 0,
    updated_ms INTEGER NOT NULL DEFAULT 0
)";

impl GroupStore {
    pub fn load(db_path: &str, legacy_json: &str) -> Self {
        let db = match rusqlite::Connection::open(db_path) {
            Ok(c) => c,
            Err(e) => {
                warn!("group db {} open failed ({}); using in-memory db", db_path, e);
                rusqlite::Connection::open_in_memory().expect("in-memory sqlite")
            }
        };
        // WAL lets readers run while one writer works; busy_timeout makes a second writer (the metrics
        // collector shares this file) wait its turn instead of failing with SQLITE_BUSY
        let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
        if let Err(e) = db.execute_batch(SCHEMA) {
            warn!("group db schema: {}", e);
        }
        let mut groups = Self::read_all(&db);
        if groups.is_empty() {
            let seed: Vec<GroupConfig> = std::fs::read_to_string(legacy_json)
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<GroupConfig>>(&s).ok())
                .filter(|v| !v.is_empty())
                .map(|v| {
                    info!("group db empty: importing {} groups from {}", v.len(), legacy_json);
                    v
                })
                .unwrap_or_else(Self::default_groups);
            for mut g in seed {
                let t = now_ms();
                g.created_ms = if g.created_ms == 0 { t } else { g.created_ms };
                g.updated_ms = t;
                Self::write(&db, &g);
                groups.insert(g.id.clone(), g);
            }
        }
        info!("group db {}: {} groups", db_path, groups.len());
        Self { groups: RwLock::new(groups), db: Mutex::new(db) }
    }

    fn read_all(db: &rusqlite::Connection) -> HashMap<String, GroupConfig> {
        let mut out = HashMap::new();
        let Ok(mut st) = db.prepare("SELECT id,name,description,owner,criteria,include,exclude,created_ms,updated_ms FROM groups") else { return out };
        let rows = st.query_map([], |r| {
            Ok(GroupConfig {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                owner: r.get(3)?,
                criteria: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                include: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                exclude: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                created_ms: r.get::<_, i64>(7)? as u64,
                updated_ms: r.get::<_, i64>(8)? as u64,
            })
        });
        if let Ok(rows) = rows {
            for g in rows.flatten() {
                out.insert(g.id.clone(), g);
            }
        }
        out
    }

    fn write(db: &rusqlite::Connection, g: &GroupConfig) {
        let r = db.execute(
            "INSERT INTO groups (id,name,description,owner,criteria,include,exclude,created_ms,updated_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, owner=excluded.owner,
               criteria=excluded.criteria, include=excluded.include, exclude=excluded.exclude, updated_ms=excluded.updated_ms",
            rusqlite::params![
                g.id, g.name, g.description, g.owner,
                serde_json::to_string(&g.criteria).unwrap_or_else(|_| "{}".into()),
                serde_json::to_string(&g.include).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&g.exclude).unwrap_or_else(|_| "[]".into()),
                g.created_ms as i64, g.updated_ms as i64,
            ],
        );
        if let Err(e) = r {
            warn!("group db write {}: {}", g.id, e);
        }
    }

    fn default_groups() -> Vec<GroupConfig> {
        let mk = |id: &str, name: &str, desc: &str, criteria: HashMap<String, Vec<String>>| GroupConfig {
            id: id.into(),
            name: name.into(),
            description: desc.into(),
            owner: "system".into(),
            criteria,
            include: vec![],
            exclude: vec![],
            created_ms: 0,
            updated_ms: 0,
        };
        vec![mk("all", "전체 채널", "라우터에 접속된 모든 채널 (기본 그룹)", HashMap::new())]
    }

    pub fn list(&self) -> Vec<GroupConfig> {
        let mut v: Vec<GroupConfig> = self.groups.read().unwrap().values().cloned().collect();
        // 기본 그룹 "all"(전체 채널)은 항상 맨 위에 고정
        v.sort_by_key(|g| (g.id != "all", g.name.clone(), g.id.clone()));
        v
    }

    pub fn get(&self, id: &str) -> Option<GroupConfig> {
        self.groups.read().unwrap().get(id).cloned()
    }

    pub fn upsert(&self, mut cfg: GroupConfig) {
        let t = now_ms();
        cfg.created_ms = self.get(&cfg.id).map(|g| g.created_ms).filter(|c| *c > 0).unwrap_or(t);
        cfg.updated_ms = t;
        Self::write(&self.db.lock().unwrap(), &cfg);
        self.groups.write().unwrap().insert(cfg.id.clone(), cfg);
    }

    pub fn remove(&self, id: &str) -> bool {
        let removed = self.groups.write().unwrap().remove(id).is_some();
        if removed {
            if let Err(e) = self.db.lock().unwrap().execute("DELETE FROM groups WHERE id=?1", [id]) {
                warn!("group db delete {}: {}", id, e);
            }
        }
        removed
    }

    /// 채널이 현재 속해야 하는 그룹 ID 목록 계산
    pub fn groups_for(&self, channel_id: &str, patient: Option<&Patient>) -> Vec<String> {
        let mut v: Vec<String> = self
            .groups
            .read()
            .unwrap()
            .values()
            .filter(|g| g.matches(channel_id, patient))
            .map(|g| g.id.clone())
            .collect();
        v.sort();
        v
    }
}
