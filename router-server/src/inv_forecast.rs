//! 패치 수요 예측 — 일별 사용(부착) 이력으로 앞으로의 필요량을 예측한다.
//!  - 이력 28일 이상: Holt-Winters 가법(추세 + 요일 계절성), 이력 7–27일: 감쇠 추세 Holt, 그 미만: 평균.
//!  - 매개변수(α, β, γ)는 작은 격자에서 1단계 예측 오차 제곱합이 가장 작은 값을 고른다.
//!  - 착용 기준선(사이트 병원): 현재 착용 인원 ÷ 착용 일수 = 하루 교체 수요. 이력이 짧을수록(28일 미만) 기준선 비중을 높여 섞는다.
//!  - 이상치(병동 개시 일괄 부착 등)는 중앙값 + 4·MAD 로 눌러서 적합한다.
//!  - 예측 구간: 잔차 표준편차 × √h, 80% (z 1.28). 최근 7일 백테스트 WAPE 로 정확도를 보인다.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Forecast {
    pub method: &'static str,
    pub history_days: usize,
    pub prior: Option<f64>,
    pub weight_hist: f64,
    pub daily: Vec<f64>,
    pub lo: Vec<f64>,
    pub hi: Vec<f64>,
    pub sd: f64,
    pub next7: f64,
    pub next30: f64,
    pub next60: f64,
    pub next90: f64,
    pub trend_pct: Option<f64>,
    pub wape: Option<f64>,
    pub params: (f64, f64, f64),
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if s.is_empty() { 0.0 } else if s.len() % 2 == 1 { s[s.len() / 2] } else { (s[s.len() / 2 - 1] + s[s.len() / 2]) / 2.0 }
}

fn clip_outliers(y: &[f64]) -> Vec<f64> {
    let m = median(y);
    let mad = median(&y.iter().map(|v| (v - m).abs()).collect::<Vec<_>>());
    let cap = m + 4.0 * mad.max(1.0);
    y.iter().map(|v| v.min(cap)).collect()
}

/// 적합 + h일 예측. 반환 (예측, 1단계 잔차 SSE, 잔차 수)
fn fit(y: &[f64], h: usize, a: f64, b: f64, g: f64, season: bool, phi: f64) -> (Vec<f64>, f64, usize) {
    let m = 7;
    let n = y.len();
    if n == 0 { return (vec![0.0; h], 0.0, 0) }
    let (mut l, mut t, mut s) = if season && n >= 2 * m {
        let l0 = y[..m].iter().sum::<f64>() / m as f64;
        let l1 = y[m..2 * m].iter().sum::<f64>() / m as f64;
        (l0, (l1 - l0) / m as f64, (0..m).map(|i| y[i] - l0).collect::<Vec<_>>())
    } else {
        (y[0], if n > 1 { y[1] - y[0] } else { 0.0 } * 0.0, vec![0.0; m])
    };
    let mut sse = 0.0;
    let mut k = 0;
    let start = if season { m } else { 1 };
    for i in start..n {
        let si = if season { s[i % m] } else { 0.0 };
        let pred = l + phi * t + si;
        let e = y[i] - pred;
        if i >= start + 2 { sse += e * e; k += 1; }
        let l_new = a * (y[i] - si) + (1.0 - a) * (l + phi * t);
        t = b * (l_new - l) + (1.0 - b) * phi * t;
        if season { s[i % m] = g * (y[i] - l_new) + (1.0 - g) * si; }
        l = l_new;
    }
    let mut out = Vec::with_capacity(h);
    let mut damp = 0.0;
    let mut p = 1.0;
    for j in 1..=h {
        p *= phi;
        damp += p;
        let si = if season { s[(n + j - 1) % m] } else { 0.0 };
        out.push((l + damp * t + si).max(0.0));
    }
    (out, sse, k)
}

fn best(y: &[f64], h: usize, season: bool) -> (Vec<f64>, f64, (f64, f64, f64)) {
    let phi = 0.9; // 감쇠 추세 — 먼 미래로 추세를 무한히 늘리지 않는다
    let mut top: Option<(f64, Vec<f64>, (f64, f64, f64), usize)> = None;
    for &a in &[0.1, 0.2, 0.35, 0.5, 0.7] {
        for &b in &[0.01, 0.05, 0.15] {
            for &g in if season { &[0.05, 0.15, 0.3][..] } else { &[0.0][..] } {
                let (fc, sse, k) = fit(y, h, a, b, g, season, phi);
                if k == 0 { continue }
                if top.as_ref().map(|x| sse < x.0).unwrap_or(true) { top = Some((sse, fc, (a, b, g), k)); }
            }
        }
    }
    match top {
        Some((sse, fc, p, k)) => (fc, (sse / k.max(1) as f64).sqrt(), p),
        None => (vec![y.iter().sum::<f64>() / y.len().max(1) as f64; h], 0.0, (0.0, 0.0, 0.0)),
    }
}

/// `y`: 완결된 날의 일별 수요(오래된 것 → 최근, 오늘 제외). `prior`: 착용 기준선(하루 교체 수요).
pub fn forecast(y_raw: &[f64], prior: Option<f64>, h: usize) -> Forecast {
    let n = y_raw.len();
    let y = clip_outliers(y_raw);
    let (method, mut fc, mut sd, params) = if n >= 28 {
        let (f, s, p) = best(&y, h, true);
        ("holt_winters", f, s, p)
    } else if n >= 7 {
        let (f, s, p) = best(&y, h, false);
        ("holt_damped", f, s, p)
    } else if n > 0 {
        let mean = y.iter().sum::<f64>() / n as f64;
        let sd = (y.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n.max(2).saturating_sub(1) as f64).sqrt();
        ("mean", vec![mean; h], sd, (0.0, 0.0, 0.0))
    } else {
        ("none", vec![0.0; h], 0.0, (0.0, 0.0, 0.0))
    };
    // 기준선과 섞기
    let w = if prior.unwrap_or(0.0) > 0.0 { (n as f64 / 28.0).min(1.0) } else { 1.0 };
    if let Some(p) = prior.filter(|p| *p > 0.0) {
        if w < 1.0 {
            for v in fc.iter_mut() { *v = w * *v + (1.0 - w) * p; }
            sd = (w * sd).max((p).sqrt()); // 이력이 짧으면 포아송 수준 불확실성
        }
    }
    let z = 1.28;
    let lo: Vec<f64> = fc.iter().enumerate().map(|(i, v)| (v - z * sd * ((i + 1) as f64).sqrt().min(3.0)).max(0.0)).collect();
    let hi: Vec<f64> = fc.iter().enumerate().map(|(i, v)| v + z * sd * ((i + 1) as f64).sqrt().min(3.0)).collect();
    let sum = |k: usize| fc.iter().take(k).sum::<f64>();
    // 추세: 최근 28일 평균 대비 앞으로 28일 예측 평균
    let trend_pct = if n >= 14 {
        let k = n.min(28);
        let past = y_raw[n - k..].iter().sum::<f64>() / k as f64;
        if past > 0.0 { Some(((sum(28) / 28.0) / past - 1.0) * 100.0) } else { None }
    } else { None };
    // 백테스트: 마지막 7일을 가리고 예측 → WAPE
    let wape = if n >= 35 {
        let train = &y[..n - 7];
        let (f, _, _) = best(train, 7, n - 7 >= 28);
        let act: f64 = y_raw[n - 7..].iter().sum();
        if act > 0.0 { Some((f.iter().zip(&y_raw[n - 7..]).map(|(a, b)| (a - b).abs()).sum::<f64>() / act * 1000.0).round() / 10.0) } else { None }
    } else { None };
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    Forecast {
        method, history_days: n, prior: prior.map(r1), weight_hist: (w * 100.0).round() / 100.0,
        next7: sum(7).round(), next30: sum(30).round(), next60: sum(60).round(), next90: sum(90).round(),
        daily: fc.iter().map(|v| r1(*v)).collect(), lo: lo.iter().map(|v| r1(*v)).collect(), hi: hi.iter().map(|v| r1(*v)).collect(),
        sd: r1(sd), trend_pct: trend_pct.map(r1), wape, params,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weekly_trend_is_followed() {
        // 평일 10, 주말 4, 하루 0.1 씩 증가
        let y: Vec<f64> = (0..84).map(|i| (if i % 7 >= 5 { 4.0 } else { 10.0 }) + i as f64 * 0.1).collect();
        let f = forecast(&y, None, 14);
        assert_eq!(f.method, "holt_winters");
        let wk: f64 = f.daily[..7].iter().sum();
        let exp: f64 = (84..91).map(|i| (if i % 7 >= 5 { 4.0 } else { 10.0 }) + i as f64 * 0.1).sum();
        assert!((wk - exp).abs() / exp < 0.1, "{wk} vs {exp}");
        assert!(f.daily[(84 + 5 - 84) % 7] < f.daily[0]); // 주말이 낮다
        assert!(f.wape.unwrap() < 10.0);
    }
    #[test]
    fn short_history_uses_prior() {
        let f = forecast(&[600.0, 1300.0], Some(146.0), 30);
        assert_eq!(f.method, "mean");
        assert!(f.daily[0] < 300.0, "{:?}", &f.daily[..3]); // 일괄 부착 2일은 기준선에 묻힌다
    }
}
