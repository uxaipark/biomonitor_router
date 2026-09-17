//! Ingest: protocol v3 binary TCP listener (one socket per gateway, or several gateways per socket in the
//! emulator's `shared` mode). Frames are CRC-checked, gateway/patch sequence numbers tracked, NACKs sent back
//! on the same socket, records stored raw per patch, and the ECG channel is handed to the legacy analysis /
//! output pipeline as an `EcgPacket` (channel_id = patch id).

use crate::protocol::{AnalysisEvent, EcgPacket, Patient};
use crate::state::AppState;
use crate::wire::{self, Item};
use crate::gateways::SeqVerdict;
use crate::patch_store::StoreOp;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

/// 소스 IP 허용 여부. 루프백은 항상 허용(로컬 에뮬레이터), 그 외는 허용목록 기준.
fn source_allowed(state: &AppState, ip: std::net::IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    match &*state.ingest_allow.lock().unwrap() {
        None => true,
        Some(set) => set.contains(&ip),
    }
}

pub async fn run(state: Arc<AppState>) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&state.cfg.ingest_addr).await?;
    info!("ingest (protocol v3) listening on {}", state.cfg.ingest_addr);
    loop {
        let (stream, peer) = listener.accept().await?;
        if !source_allowed(&state, peer.ip()) {
            debug!("ingest connection from {} rejected (not in allowlist)", peer);
            continue;
        }
        let st = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(st, stream, peer).await {
                debug!("ingest connection {} closed: {}", peer, e);
            }
        });
    }
}

/// Per-connection state kept across frames.
struct Conn {
    id: u64,
    addr: String,
    tx: mpsc::Sender<Vec<u8>>,
}

async fn handle_conn(state: Arc<AppState>, stream: TcpStream, peer: std::net::SocketAddr) -> anyhow::Result<()> {
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    // Writer task: control frames (NACK) queued by the gateway table go out on this socket.
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if wr.write_all(&frame).await.is_err() {
                break;
            }
        }
    });
    let conn = Conn { id: CONN_SEQ.fetch_add(1, Ordering::Relaxed), addr: peer.to_string(), tx };
    let peer_ip = peer.ip();
    state.ingest_conns.fetch_add(1, Ordering::Relaxed);
    *state.ingest_sources.lock().unwrap().entry(peer_ip).or_insert(0) += 1;

    let mut dec = wire::Decoder::new();
    let mut items = VecDeque::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match rd.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if !source_allowed(&state, peer_ip) {
            debug!("ingest connection {} dropped (allowlist changed)", peer_ip);
            break;
        }
        state.total_bytes.fetch_add(n as u64, Ordering::Relaxed);
        dec.feed(&buf[..n], &mut items);
        while let Some(item) = items.pop_front() {
            match item {
                Item::BadCrc(hdr) => {
                    state.gateways.on_corrupt(conn.id, &conn.addr, &conn.tx, &hdr);
                    state.push_event("bad_crc", None, format!("gw {} seq {}: CRC mismatch ({})", hdr.gw_id, hdr.seq, conn.addr));
                }
                Item::Frame(hdr, payload) => match wire::parse_payload(hdr, &payload) {
                    Ok(frame) => process_frame(&state, &conn, &frame),
                    Err(e) => {
                        wire_inc(&state.gateways.totals.bad_payload);
                        warn!("gw {} seq {}: payload parse error {:?}", hdr.gw_id, hdr.seq, e);
                    }
                },
            }
        }
        if dec.buffered() > wire::MAX_PAYLOAD + wire::HEADER_LEN {
            warn!("ingest {}: buffer overrun, closing", conn.addr);
            break;
        }
    }
    // Decoder-level anomalies are folded into the totals when the socket closes.
    let t = &state.gateways.totals;
    t.bad_magic.fetch_add(dec.bad_magic, Ordering::Relaxed);
    t.bad_version.fetch_add(dec.bad_version, Ordering::Relaxed);
    t.oversize.fetch_add(dec.oversize, Ordering::Relaxed);
    t.garbage_bytes.fetch_add(dec.garbage_bytes, Ordering::Relaxed);
    t.resync.fetch_add(dec.resync, Ordering::Relaxed);

    writer.abort();
    state.ingest_conns.fetch_sub(1, Ordering::Relaxed);
    {
        let mut src = state.ingest_sources.lock().unwrap();
        if let Some(n) = src.get_mut(&peer_ip) {
            *n -= 1;
            if *n == 0 {
                src.remove(&peer_ip);
            }
        }
    }
    // Every gateway that was riding this socket is down; its patches go "disconnected" for subscribers.
    for gw_id in state.gateways.on_conn_closed(conn.id) {
        state.push_event("link", None, format!("gw {} disconnected ({})", gw_id, conn.addr));
        for channel_id in state.registry.channels_of_gateway(&gw_id.to_string()) {
            state.registry.set_connected(&channel_id, false);
            state.emit_channel_event(
                &channel_id,
                vec![AnalysisEvent { kind: "ingest_disconnected".into(), detail: "gateway socket closed".into() }],
            );
        }
    }
    Ok(())
}

fn wire_inc(a: &AtomicU64) {
    a.fetch_add(1, Ordering::Relaxed);
}

fn process_frame(state: &Arc<AppState>, conn: &Conn, frame: &wire::Frame<'_>) {
    let hdr = &frame.hdr;
    if frame.ctrl.is_some() {
        // Control frames only travel router → gateway; one arriving here is harmless noise.
        wire_inc(&state.gateways.totals.ctrl_rx);
        return;
    }
    let (verdict, link_changed) = state.gateways.on_frame(conn.id, &conn.addr, &conn.tx, hdr);
    if link_changed {
        state.push_event("link", None, format!("gw {} connected ({})", hdr.gw_id, conn.addr));
    }
    if verdict == SeqVerdict::Dup {
        return; // an exact duplicate frame: already stored and forwarded
    }
    if let Some(st) = frame.gw_status {
        state.gateways.on_status(hdr.gw_id, st);
    }
    let gw_key = hdr.gw_id.to_string();
    if let Some(json) = frame.meta_json {
        match serde_json::from_slice::<serde_json::Value>(json) {
            Ok(meta) => {
                let changed = state.gateways.on_meta(hdr.gw_id, &meta);
                if changed {
                    state.send_store(StoreOp::Meta { gw_id: hdr.gw_id, json: json.to_vec() });
                    apply_meta_patches(state, hdr.gw_id, &meta);
                }
            }
            Err(_) => wire_inc(&state.gateways.totals.meta_bad_json),
        }
    }
    if frame.records.is_empty() {
        return;
    }
    let (_gw_name, loc) = state.gateways.location_of(hdr.gw_id).unwrap_or_default();
    let space = loc.room.clone();
    for rec in &frame.records {
        state.total_packets.fetch_add(1, Ordering::Relaxed);
        state.send_store(StoreOp::Record { ts_ms: hdr.ts_ms, gw_id: hdr.gw_id, raw: rec.raw.to_vec() });
        let channel_id = rec.patch_id.to_string();
        // Per-patch packet counter: a gap here = packets lost anywhere between patch and router.
        // A frame that answers a NACK carries older patch seqs by design: store it, skip the seq check.
        let pseq = if verdict == SeqVerdict::Recovered {
            crate::registry::PatchSeq::Ok
        } else {
            state.registry.track_patch_seq(&channel_id, rec.seq)
        };
        match pseq {
            crate::registry::PatchSeq::Gap(n) => {
                wire_inc(&state.gateways.totals.patch_seq_gap);
                state.gateways.totals.patch_seq_missing.fetch_add(n as u64, Ordering::Relaxed);
                state.total_lost_packets.fetch_add(n as u64, Ordering::Relaxed);
            }
            crate::registry::PatchSeq::Dup => {
                // The emulator sends pace marks (ch 10) as a second record of the same patch and seq in the
                // same frame: a continuation, not a duplicate packet. Only a repeated waveform record counts.
                let has_wave = rec.channels.iter().any(|c| c.ch == wire::CH_ECG);
                if has_wave {
                    wire_inc(&state.gateways.totals.patch_seq_dup);
                } else {
                    wire_inc(&state.gateways.totals.patch_cont);
                }
                continue;
            }
            crate::registry::PatchSeq::Reorder => {
                wire_inc(&state.gateways.totals.patch_seq_reorder);
                continue;
            }
            _ => {}
        }
        let Some(ecg) = rec.channels.iter().find(|c| c.ch == wire::CH_ECG && c.dtype == 1) else { continue };
        let samples: Vec<f32> = ecg
            .data
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 * 0.001)
            .collect();
        let fs = state.registry.sample_rate_of(&channel_id).unwrap_or(250);
        let quality = if rec.flags & wire::R_LEAD_OFF != 0 {
            "leadoff"
        } else if rec.flags & wire::R_MOTION != 0 {
            "noisy"
        } else {
            "good"
        };
        let pkt = EcgPacket {
            channel_id: channel_id.clone(),
            seq: rec.seq as u64,
            ts_ms: hdr.ts_ms,
            sample_rate: fs,
            samples,
            quality: quality.into(),
            moving: rec.flags & wire::R_MOTION != 0,
            gateway_id: gw_key.clone(),
            space: space.clone(),
        };
        state.registry.note_patch(&channel_id, rec.patient_id, rec.flags, rec.battery, rec.rssi);
        process_ecg(state, pkt);
    }
    state.gateways.add_records(hdr.gw_id, frame.records.len());
}

/// META patches[] → registry rows (patch → patient/channels/location). Names come from the EMR sync.
fn apply_meta_patches(state: &Arc<AppState>, gw_id: u32, meta: &serde_json::Value) {
    let Some(patches) = meta.get("patches").and_then(|p| p.as_array()) else { return };
    let (gw_name, loc) = state.gateways.location_of(gw_id).unwrap_or_default();
    let gw_key = gw_id.to_string();
    for p in patches {
        let Some(patch_id) = p.get("patch_id").and_then(|x| x.as_u64()) else { continue };
        let channel_id = patch_id.to_string();
        let patient_id = p.get("patient_id").and_then(|x| x.as_u64()).unwrap_or(0);
        let profile_id = p.get("profile_id").and_then(|x| x.as_u64()).unwrap_or(0);
        let mrn = p.get("mrn").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let ecg_fs = p
            .get("channels")
            .and_then(|c| c.as_array())
            .and_then(|a| a.iter().find(|c| c.get("id").and_then(|x| x.as_u64()) == Some(1)))
            .and_then(|c| c.get("fs").and_then(|x| x.as_u64()))
            .unwrap_or(250) as u32;
        let prev = state.registry.patient_of(&channel_id);
        let patient = Patient {
            id: patient_id.to_string(),
            name: prev.as_ref().map(|q| q.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| mrn.clone()),
            building: loc.building.clone(),
            floor: loc.floor.to_string(),
            ward: prev.as_ref().map(|q| q.ward.clone()).unwrap_or_default(),
            zone: gw_name.clone(),
            room: loc.room.clone(),
            doctor: prev.as_ref().map(|q| q.doctor.clone()).unwrap_or_default(),
            department: prev.as_ref().map(|q| q.department.clone()).unwrap_or_default(),
            nurse: prev.as_ref().map(|q| q.nurse.clone()).unwrap_or_default(),
            profile_no: profile_id,
            sex: prev.as_ref().map(|q| q.sex.clone()).unwrap_or_default(),
            birth: prev.as_ref().map(|q| q.birth.clone()).unwrap_or_default(),
            blood: prev.as_ref().map(|q| q.blood.clone()).unwrap_or_default(),
            conditions: prev.as_ref().map(|q| q.conditions.clone()).unwrap_or_default(),
        };
        let changed = prev.as_ref() != Some(&patient);
        state.registry.upsert_meta(&channel_id, patient);
        state.registry.set_link(&channel_id, &gw_key, &loc.room, ecg_fs, &mrn, profile_id);
        if changed {
            state.recompute_channel_groups(&channel_id);
        }
    }
}

/// ECG 패킷 1건: 분석 서버가 살아 있으면 forward 후 응답(seq)과 병합, 아니면 즉시 패스스루 출력.
fn process_ecg(state: &Arc<AppState>, pkt: EcgPacket) {
    state.registry.push_packet(&pkt);
    if state.analysis_up() {
        #[derive(serde::Serialize)]
        struct EcgLine<'a> {
            #[serde(rename = "type")]
            t: &'static str,
            #[serde(flatten)]
            pkt: &'a EcgPacket,
        }
        if let Ok(line) = serde_json::to_string(&EcgLine { t: "ecg", pkt: &pkt }) {
            state.send_analysis(line);
        }
    } else {
        let taken = state.registry.take_matching(&pkt.channel_id, pkt.seq);
        state.emit_stream(taken.unwrap_or(pkt), None, Vec::new());
    }
}
