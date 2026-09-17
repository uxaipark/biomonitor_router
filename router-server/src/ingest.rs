//! Ingest: protocol v3 binary TCP listener (one socket per gateway, or several gateways per socket in the
//! emulator's `shared` mode). Frames are CRC-checked, gateway/patch sequence numbers tracked, NACKs sent back
//! on the same socket, records stored raw per patch, and the ECG channel is handed to the legacy analysis /
//! output pipeline as an `EcgPacket` (channel_id = patch id).

use crate::protocol::{AnalysisEvent, EcgPacket, Patient, Vitals, WaveBlock};
use crate::state::AppState;
use crate::wire::{self, Item};
use crate::gateways::SeqVerdict;
use crate::patch_store::StoreOp;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream};
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
    // ~2,200 gateways connect at once after an emulator (re)start: the std default backlog of 128 overflows
    // into SYN cookies, so listen with a backlog sized for the fleet.
    let addr: std::net::SocketAddr = state.cfg.ingest_addr.parse()?;
    let sock = if addr.is_ipv4() { TcpSocket::new_v4()? } else { TcpSocket::new_v6()? };
    sock.set_reuseaddr(true)?;
    sock.bind(addr)?;
    let listener = sock.listen(4096)?;
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
    set_keepalive(&stream);
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

/// TCP keepalive (idle 30 s, probe every 10 s, 3 probes): a gateway whose host vanished without FIN/RST — the
/// emulator redeployed, or its route moved to another interface — is closed in ~60 s instead of holding a
/// half-open socket (and its gateway row) forever. A live but silent gateway still answers the probes.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn set_keepalive(stream: &TcpStream) {
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    #[cfg(target_os = "linux")]
    let idle_opt = libc::TCP_KEEPIDLE;
    #[cfg(target_os = "macos")]
    let idle_opt = libc::TCP_KEEPALIVE;
    for (level, opt, val) in [
        (libc::SOL_SOCKET, libc::SO_KEEPALIVE, 1),
        (libc::IPPROTO_TCP, idle_opt, 30),
        (libc::IPPROTO_TCP, libc::TCP_KEEPINTVL, 10),
        (libc::IPPROTO_TCP, libc::TCP_KEEPCNT, 3),
    ] {
        let v: libc::c_int = val;
        // SAFETY: fd is a live socket owned by `stream`; the option value is a c_int of the declared size.
        unsafe {
            libc::setsockopt(fd, level, opt, &v as *const _ as *const libc::c_void, std::mem::size_of::<libc::c_int>() as libc::socklen_t);
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn set_keepalive(_stream: &TcpStream) {}

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
                    continue;
                }
                wire_inc(&state.gateways.totals.patch_cont);
                // fall through: the continuation streams as a marks-only packet of the same seq
            }
            crate::registry::PatchSeq::Restart => wire_inc(&state.gateways.totals.patch_seq_restart),
            crate::registry::PatchSeq::Reorder => {
                wire_inc(&state.gateways.totals.patch_seq_reorder);
                continue;
            }
            _ => {}
        }
        let bundle_ms = state.registry.bundle_ms_of(&channel_id).unwrap_or(200).max(1) as u32;
        let mut pkt = EcgPacket {
            channel_id: channel_id.clone(),
            seq: rec.seq as u64,
            ts_ms: hdr.ts_ms,
            sample_rate: state.registry.sample_rate_of(&channel_id).unwrap_or(250),
            samples: Vec::new(),
            quality: if rec.flags & wire::R_LEAD_OFF != 0 {
                "leadoff"
            } else if rec.flags & wire::R_MOTION != 0 {
                "noisy"
            } else {
                "good"
            }
            .into(),
            moving: rec.flags & wire::R_MOTION != 0,
            gateway_id: gw_key.clone(),
            space: space.clone(),
            flags: rec.flags,
            battery: rec.battery,
            rssi: rec.rssi,
            vitals: Vitals::default(),
            pace: Vec::new(),
            waves: Vec::new(),
            wave_i16: Vec::new(),
        };
        for c in &rec.channels {
            let i16s = || c.data.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]));
            let u16s = || c.data.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]]));
            match (c.ch, c.dtype) {
                (ch, 1) if wire::wave_info(ch).is_some() => {
                    let (key, scale) = wire::wave_info(ch).unwrap();
                    let axes = wire::axes(ch) as u8;
                    if ch == wire::CH_ECG {
                        pkt.samples = i16s().map(|v| v as f32 * scale).collect();
                        pkt.sample_rate = (c.n as u32 * 1000) / bundle_ms;
                    }
                    pkt.waves.push(WaveBlock { ch, key: key.to_string(), fs: (c.n as u32 * 1000) / bundle_ms, axes, n: c.n, scale });
                    pkt.wave_i16.extend(i16s());
                }
                // 1 Hz numerics: 0 = invalid / no reading
                (wire::CH_HR, 2) => pkt.vitals.hr = c.data.first().copied().filter(|v| *v > 0),
                (wire::CH_RESP, 2) => pkt.vitals.resp = c.data.first().copied().filter(|v| *v > 0),
                (wire::CH_SPO2, 2) => pkt.vitals.spo2 = c.data.first().copied().filter(|v| *v > 0),
                (wire::CH_TEMP, 1) => pkt.vitals.temp = i16s().next().filter(|v| *v != 0).map(|v| v as f32 * 0.01),
                (wire::CH_GLUCOSE, 3) => pkt.vitals.glucose = u16s().next().filter(|v| *v != 0).map(|v| v as f32 * 0.1),
                (wire::CH_PACE, 3) => pkt.pace = u16s().collect(),
                _ => {}
            }
        }
        state.registry.note_patch(&channel_id, rec.patient_id, rec.flags, rec.battery, rec.rssi);
        if pkt.waves.is_empty() && pkt.vitals.is_empty() && pkt.pace.is_empty() {
            continue;
        }
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
        let bundle_ms = meta.get("bundle_ms").and_then(|x| x.as_u64()).unwrap_or(200) as u32;
        let keys: Vec<String> = p
            .get("channels")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().filter_map(|c| c.get("key").and_then(|x| x.as_str()).map(String::from)).collect())
            .unwrap_or_default();
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
        state.registry.set_stream_layout(&channel_id, bundle_ms, keys);
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
