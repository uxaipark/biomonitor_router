//! router_core — ECG 소켓 채널 라우터 핵심 라이브러리.
//!
//! 다른 서비스에 이식할 수 있도록 모든 로직을 라이브러리로 노출하고,
//! main.rs 는 부트스트랩만 담당한다.

pub mod admin_api;
pub mod analysis_link;
pub mod config;
pub mod db_link;
pub mod grouping;
pub mod ingest;
pub mod output;
pub mod protocol;
pub mod registry;
pub mod state;
pub mod wire;
pub mod patch_store;
pub mod gateways;
pub mod emu_link;
pub mod sysmon;
pub mod alarms;
