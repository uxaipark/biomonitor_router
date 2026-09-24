//! 최소 HTTP/1.1 클라이언트 (EMR 연동용): 임의 헤더·본문, Content-Length / chunked 응답, 시간 제한.
//! `http://` 만 지원한다 — 실제 병원 EMR(HTTPS)에 붙일 때는 TLS 를 앞단(프록시·stunnel)에 두거나 rustls 를 넣는다.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// `http://host[:port]/path?query` → (host:port, host, path)
pub fn split_url(url: &str) -> anyhow::Result<(String, String, String)> {
    let rest = url.strip_prefix("http://").ok_or_else(|| anyhow::anyhow!("https 는 아직 지원하지 않습니다: {url}"))?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let addr = if hostport.contains(':') { hostport.to_string() } else { format!("{hostport}:80") };
    Ok((addr, hostport.to_string(), path.to_string()))
}

pub async fn request(method: &str, url: &str, headers: &[(&str, String)], body: Option<&[u8]>, timeout: Duration) -> anyhow::Result<Resp> {
    let (addr, host, path) = split_url(url)?;
    let fut = async {
        let mut s = TcpStream::connect(&addr).await?;
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: biomonitor-router\r\n");
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        if let Some(b) = body {
            req.push_str(&format!("Content-Length: {}\r\n", b.len()));
        }
        req.push_str("\r\n");
        let mut out = req.into_bytes();
        if let Some(b) = body {
            out.extend_from_slice(b);
        }
        s.write_all(&out).await?;
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).await?;
        anyhow::Ok(raw)
    };
    let raw = tokio::time::timeout(timeout, fut).await.map_err(|_| anyhow::anyhow!("시간 초과 ({} s)", timeout.as_secs()))??;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| anyhow::anyhow!("응답 헤더가 없습니다"))?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let rest = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).unwrap_or(0);
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    let chunked = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked { dechunk(rest) } else { rest.to_vec() };
    Ok(Resp { status, headers, body })
}

fn dechunk(mut rest: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rest.len());
    loop {
        let Some(i) = rest.windows(2).position(|w| w == b"\r\n") else { break };
        let size = String::from_utf8_lossy(&rest[..i]);
        let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
        let after = &rest[i + 2..];
        if n == 0 || after.len() < n {
            break;
        }
        out.extend_from_slice(&after[..n]);
        rest = after[n..].strip_prefix(b"\r\n").unwrap_or(&[]);
    }
    out
}

pub fn basic(user: &str, pass: &str) -> String {
    format!("Basic {}", b64(format!("{user}:{pass}").as_bytes(), false))
}

/// base64 (표준 또는 URL-safe, 패딩 없음)
pub fn b64(data: &[u8], url_safe: bool) -> String {
    let t: &[u8; 64] = if url_safe { b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" } else { b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" };
    let mut s = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(t[(n >> 18) as usize & 63] as char);
        s.push(t[(n >> 12) as usize & 63] as char);
        if c.len() > 1 {
            s.push(t[(n >> 6) as usize & 63] as char);
        } else if !url_safe {
            s.push('=');
        }
        if c.len() > 2 {
            s.push(t[n as usize & 63] as char);
        } else if !url_safe {
            s.push('=');
        }
    }
    s
}

pub fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

pub fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

#[cfg(test)]
mod tests {
    #[test]
    fn b64_matches_python() {
        assert_eq!(super::b64(b"prch_iface:prch-2575", false), "cHJjaF9pZmFjZTpwcmNoLTI1NzU=");
        assert_eq!(super::b64(b"ab", true), "YWI");
    }
}
