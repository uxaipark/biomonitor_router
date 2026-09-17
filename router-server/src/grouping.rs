use crate::protocol::Patient;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

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

/// 그룹 저장소. groups.json 으로 영속화한다.
pub struct GroupStore {
    groups: RwLock<HashMap<String, GroupConfig>>,
    path: PathBuf,
}

impl GroupStore {
    pub fn load(path: &str) -> Self {
        let path = PathBuf::from(path);
        let groups = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<GroupConfig>>(&s).ok())
            .map(|v| v.into_iter().map(|g| (g.id.clone(), g)).collect())
            .unwrap_or_else(|| {
                let defaults = Self::default_groups();
                defaults.into_iter().map(|g| (g.id.clone(), g)).collect()
            });
        let store = Self {
            groups: RwLock::new(groups),
            path,
        };
        store.save();
        store
    }

    fn default_groups() -> Vec<GroupConfig> {
        let mut v = vec![GroupConfig {
            id: "all".into(),
            name: "전체 채널".into(),
            description: "라우터에 접속된 모든 채널 (기본 그룹)".into(),
            owner: "system".into(),
            criteria: HashMap::new(),
            include: vec![],
            exclude: vec![],
        }];
        for ward in ["W1", "W2", "W3"] {
            let mut criteria = HashMap::new();
            criteria.insert("ward".to_string(), vec![ward.to_string()]);
            v.push(GroupConfig {
                id: format!("ward-{}", ward.to_lowercase()),
                name: format!("병동 {}", ward),
                description: format!("{} 병동 재원 환자", ward),
                owner: "system".into(),
                criteria,
                include: vec![],
                exclude: vec![],
            });
        }
        let mut criteria = HashMap::new();
        criteria.insert("department".to_string(), vec!["Cardiology".to_string()]);
        v.push(GroupConfig {
            id: "dept-cardiology".into(),
            name: "순환기내과".into(),
            description: "순환기내과 소속 환자".into(),
            owner: "system".into(),
            criteria,
            include: vec![],
            exclude: vec![],
        });
        v
    }

    pub fn save(&self) {
        let list = self.list();
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(&self.path, json);
        }
    }

    pub fn list(&self) -> Vec<GroupConfig> {
        let mut v: Vec<GroupConfig> = self.groups.read().unwrap().values().cloned().collect();
        // 기본 그룹 "all"(전체 채널)은 항상 맨 위에 고정
        v.sort_by_key(|g| (g.id != "all", g.id.clone()));
        v
    }

    pub fn get(&self, id: &str) -> Option<GroupConfig> {
        self.groups.read().unwrap().get(id).cloned()
    }

    pub fn upsert(&self, cfg: GroupConfig) {
        self.groups.write().unwrap().insert(cfg.id.clone(), cfg);
        self.save();
    }

    pub fn remove(&self, id: &str) -> bool {
        let removed = self.groups.write().unwrap().remove(id).is_some();
        if removed {
            self.save();
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
