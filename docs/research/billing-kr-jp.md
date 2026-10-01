# Korea / Japan: ECG monitoring billing codes, claim forms, and report items (as of Oct 2026)

Scope: multi-day continuous single-lead ECG from wearable patches (inpatients and ambulatory/MCT-style outpatients). The goal is to generate a daily ECG report and a pre-filled insurance claim.
Tags: **[V]** means checked against a primary or official document. **[S]** means secondary (news, vendor, blog). **unverified** means not confirmed.

---

## KOREA (국민건강보험 / HIRA)

### 1. Fee codes (EDI 수가코드) — 제2부 제2장 검사료, 제3절 기능검사료, **나-725 심전도검사**

Source [V]: HIRA 「건강보험요양급여비용」 2026년 3월판, which includes 보건복지부 고시 제2025-249호 (행위 급여목록·상대가치점수), pp.238–240: https://www.hira.or.kr/ebooksc/2026/03/BZ202603053039374.pdf

| 분류번호 | EDI 코드 | 명칭 (고시 원문) | 상대가치점수 | 비고 (고시 "주") |
|---|---|---|---|---|
| 나-725 가 | E6541 | 심전도 기록 및 판독 [표준 12유도] | 104.17 | |
| 나-725 다(1) | **E6544** | 심전도 침상감시 [1일당] Bedside ECG Monitoring | 201.40 | 1회용 Electrode 별도 산정 |
| 나-725 다(2) 가) | **E6545** | 홀터기록 – 48시간 이내 | 629.49 | 1회용 Electrode·Paper·Battery 재료대 별도 |
| 나-725 다(2) 나) | **E6556** | 홀터기록 – 48시간 초과 7일 이내 | 1,677.68 | 「선별급여 지정 및 실시 등에 관한 기준」 별표2 적용 (선별급여) |
| 나-725 다(2) 다) | **E6557** | 홀터기록 – 7일 초과 14일 이내 | 2,292.09 | 선별급여 (별표2) |
| 나-725 다(3) | **E6546** | 일상 생활의 간헐적 심전도 감시 [1회당] Event Recording EKG | 301.91 | 재료대 별도 |
| 나-725 다(4) | **EX871** | 원격심박기술에 의한 감시 [1일당] Telecardiographic Monitoring | 474.27 | 재료대는 소정점수에 포함, 별도 산정 불가 |
| 나-725-3 가/나/다 | E6551 / E6552 / E6553 | 이식형 사건 기록기 삽입술 / 제거술 / 기능조정 및 심전도 분석 | 4,892.00 / 2,178.70 / 339.47 | ILR 기기는 별도 |
| 나-727 | E6547 (E6548) | 24시간 혈압측정검사 [1일당] (침상감시 시 184.85점) | 191.28 | reference only |

**Conversion to KRW (2026)** [V for 환산지수; amounts are computed]
- 2026 환산지수: 의원 95.6원, 병원 유형 83.8원. Source: https://www.monews.co.kr/news/articleView.html?idxno=404368 and https://www.doctorsnews.co.kr/news/articleView.html?idxno=159715
- 종별가산율 for 행위 (same 2026 HIRA book, 제1부 Ⅱ) [V]: 상급종합 15%, 종합병원 10%, 병원·요양병원 5%, 의원 0%.
- Formula: 금액 = 점수 × 환산지수 × (1 + 종별가산율), rounded to 10원.

| 코드 | 의원 | 병원 (+5%) | 종합병원 (+10%) | 상급종합 (+15%) |
|---|---|---|---|---|
| E6544 침상감시/일 | 19,250 | 17,720 | 18,570 | 19,410 |
| E6545 홀터 ≤48h | 60,180 | 55,390 | 58,030 | 60,660 |
| E6556 홀터 48h–7d | 160,390 | 147,620 | 154,650 | 161,680 |
| E6557 홀터 7–14d | 219,120 | 201,680 | 211,280 | 220,890 |
| E6546 이벤트/회 | 28,860 | 26,570 | 27,830 | 29,100 |
| EX871 원격심박감시/일 | 45,340 | 41,730 | 43,720 | 45,710 |

Cross-checks: news reports E6557 at 상급종합 220,892원 and EX871 at 45,701원 (both match within rounding). For history, the 2022 launch prices were 54,805 / 146,603 / 199,555원 [S].

**Long-term Holter (E6556/E6557) — 신설 and 산정기준** [V/S]
- 시행 2022-02-01, 보건복지부 고시 제2022-26호(행위). It split 홀터기록 into ≤48h / 48h–7d / 7–14d, mainly because of disposable wearable patches (패치형, 손목형).
  - Sources: https://www.dailymedi.com/news/news_view.php?wr_id=880127 and https://www.docdocdoc.co.kr/news/articleView.html?idxno=2018647
- **선별급여, 본인부담률 80%** [V]. 선별급여목록 별표2 row "나725다(2)나), 다) … 80%, 적용일 2022-02-01, 평가주기 3년": https://www.law.go.kr/LSW/flDownload.do?flSeq=151430065&bylClsCd=200201
  - On the claim these lines go to **항 B "100분의80 본인부담", 목 03 진료행위**, not to 항 09 검사료.
  - Re-evaluation (적합성평가) was due around 2025. The current status after re-evaluation is unverified, but the 2026 book still shows them as 선별급여.
- 급여기준 [V; text reproduced by 대한재활의학과의사회 and sondoctor]:
  - Sources: https://www.rm.or.kr/?c=3%2F22&uid=5698 and https://sondoctor.co.kr/1314
  - 적응증 (any one of):
    1. 부정맥 증상이 있거나 심전도에 부정맥이 기록되어 장시간 모니터링이 필요한 경우
    2. 반복되는 실신의 원인 진단
    3. 부정맥 시술적·약물적 치료 후 재발 여부 확인
    4. 뇌졸중 이후 심방세동 진단이 필요한 경우
  - 산정요건:
    1. 진료의사 처방에 따라 환자가 부착한다.
    2. 저장된 기록을 **요양기관 내에서 진료의사가 판독**한다. 판독 is included in the fee; there is no separate 판독료.
    3. The continuous record from start to end must be kept (기록지 보관).
    4. 판독소견서 required items: see §3 below.
  - Frequency limits (횟수 제한): none found in the published criteria (unverified).
- Duration tiering: the tier is chosen by total recording time (≤48h, >48h–7d, >7–14d). Recording beyond 14 days has no code. Splitting one episode into several claims is not addressed in the sources found (unverified).

**EX871 원격심박기술에 의한 감시 (inpatient wearable telemetry)** [V for points; S for criteria]
- 대상: 부정맥 발생 위험이 높아 실시간 감시 또는 치료효과 연속 모니터링이 필요한 환자.
- Difference from E6544: E6544 covers only bed-bound (침상) patients. EX871 requires real-time monitoring that continues while the patient moves between beds, wards and units. HiCardi (동아ST) was listed 2025-12-23; Thync (씨어스/대웅) and MEMO Cue (휴이노) are also reported under these codes.
  - Sources: https://www.startuptoday.co.kr/news/articleView.html?idxno=563716 and https://www.monews.co.kr/news/articleView.html?idxno=408569
- Not found: the exact HIRA 세부인정기준 text for EX871, including whether it can be billed together with E6544 on the same day, whether it applies to outpatients, and any day limit (unverified). The most likely rule is per day (1일당) with no same-day co-billing with E6544 (unverified).
- 씨어스 disclosures list the codes the product line bills under: E6545 (1–2일), E6556 (3–7일), E6557 (8–14일), E6544, EX871, E7230 (SpO2/일), E6547/48 (ABPM) [S]: https://kind.krx.co.kr/external/2025/05/12/000102/20250512000282/11013.htm

### 2. 요양급여비용 청구 서식 (claim forms)

Governing 고시: 「요양급여비용 청구방법, 심사청구서·명세서서식 및 작성요령」. The HIRA compiled edition (2024년 7월판) is used here [V]: https://www.hira.or.kr/ebooksc/2024/09/BZ202409090480881.pdf

**Form numbers**
| 서식 | 서식번호 (EDI) | 별지 |
|---|---|---|
| 요양급여비용 심사청구서 | GI01 | 제9호, 9-2, 9-3 |
| 명세서 – 의과입원 | GI02 | 제10호, 10-2 |
| 명세서 – 의과외래 (일자별 / 정률 / 정액) | GI03 | 제11호, 11-2, 11-3 (작성요령 uses "11-1, 11-2") |

Note: 외래 명세서 are written **per visit date (방문일자별)**. 입원 명세서 combine the whole admission period, split by month for claiming.

**Header fields (명세서 일반내역, EDI record "A")**
- 청구번호, 명세서일련번호, 서식번호
- 요양기관기호 (8자리), 의료급여 보장기관기호, 공상 등 구분, 정액·정률구분
- 보완/추가청구 시 원 접수번호·사유코드
- 최초입원개시일, 가입자(세대주) 성명, **증번호**, **수진자 성명**, **수진자 주민등록번호** (13자리; masking applies on printed or receipt copies only, the claim itself carries the full number)
- 요양급여일수, 입원일수, 입원경로, 진료결과
- Amount fields: 요양급여비용총액1, 본인일부부담금, 본인부담상한액초과금, 청구액, 지원금, 장애인의료비, 대불금, 요양급여비용총액2, 보훈청구액, 100분의100 본인부담금총액, 100분의100미만 총액·본인부담·청구액
- 명칭란 also shows 진료과목, 상해외인, 특정기호 (e.g., 산정특례 V-codes), 면허종류·면허번호.

**상병내역 (record "B")**
- 상병분류구분: 1 = 주상병 (first position only), 2 = 부상병, 3 = 배제된 상병.
- 상병분류기호: KCD, up to 6 characters, uppercase, no dots or symbols.
- Also 진료과목 code (별표5), 내과 세부전문과목, 내원일자 (외래) or 당월요양개시일 (입원), and the 면허종류·면허번호 of the physician for the 주상병.

**진료내역 (record "C", one line per code)**
- 항번호: 01 진찰료, 02 입원료, 03 투약료, 04 주사료, 05 마취료, 06 이학요법, 07 정신요법, 08 처치·수술, **09 검사료**, 10 영상, S 특수장비, T 특수재료, **A/B/D/E (50/80/30/90% 본인부담)**, U 100/100, V 보훈, W 비급여.
- 목번호: under 검사 01 자체검사 / 02 위탁검사. Under A/B/D/E/U: 01 의약품, 02 치료재료, **03 진료행위**.
- 줄번호; 코드구분 (1 수가, 2 준용, 3 보험등재약…); 코드 (9자리); 단가 (점수 × 점당단가, rounded to 10원); 1일투여량/실시횟수; 총투여일수/실시횟수; 1회투약량; 금액 (= 단가 × 1회량 × 1일횟수 × 일수); 변경일; 실시 의료인 **면허종류·면허번호**.
- 특정내역 (record "D"): can be attached per 명세서 or per 줄번호 for justifications.

**Mapping examples**
- Outpatient 7-day patch: E6556 goes to 항 B, 목 03, 실시횟수 1. The patch device or electrode goes to 항 B or T as 치료재료, if separately billable. Patch devices are often bundled or registered as materials; check the product's 치료재료 code (unverified).
- 24h Holter: E6545 goes to 항 09, 목 01.
- Inpatient telemetry: EX871 goes to 항 09, 목 01, with 1일투여량 1 and 총일수 = number of days monitored.

**본인부담 (general, 건강보험)**
- 외래: 의원 30%, 병원 40%, 종합 50%, 상급종합 60%.
- 입원: 20%.
- These are standard rules from memory and were not re-verified this session (unverified). For 선별급여 items, 80% overrides the rate.

**진료비 계산서·영수증**: 국민건강보험법 시행규칙 별지 제6호서식 (unverified number). Columns: 급여 (일부본인부담: 본인부담금/공단부담금, 전액본인부담), 비급여 (선택진료 이외), by 항목 (진찰료… 검사료…), 환자 정보, 진료기간, 영수액. A 세부산정내역서 is also issuable on request.

**KCD (질병분류)**: **KCD-9 (제9차 개정)** was 고시 2025-07-01 and 시행 2026-01-01. It keeps the ICD-10 structure. Use KCD-9 for 2026 claims; KCD-8 still applies to 2025 dates of service.
- Source: https://www.koicd.kr/kcd/kcds.do and https://mods.go.kr (제9차 개정고시)

Common indications for long-term ECG (ICD-10-based codes, the same in KCD-8 and KCD-9 unless noted):
| 코드 | 명칭 |
|---|---|
| I48.0 / I48.1 / I48.2 / I48.9 | 발작성 / 지속성 / 만성(영구) / 상세불명 심방세동. KCD 4th/5th-character splits such as I48.1x may differ; verify in KOICD |
| I48.3/I48.4 (or I48.x) | 심방조동 |
| I47.1 / I47.2 | 상심실성 빈맥 / 심실빈맥 |
| I49.1 / I49.3 / I49.5 / I49.9 | 심방조기탈분극 / 심실조기탈분극 / 동기능부전증후군 / 상세불명 부정맥 |
| I44.0–I44.2, I45.x | 방실차단 1–3도, 기타 전도장애 |
| R00.0 / R00.1 / R00.2 | 빈맥 / 서맥 / **두근거림** |
| R55 | **실신 및 허탈** |
| R42 | 어지럼 |
| I63.x / I64 / G45.x | 뇌경색 / 뇌졸중 / TIA (post-stroke AF screening indication) |
| I50.x, I25.x, Z95.0, Z86.7x | 심부전, 허혈성심질환, 심박조율기 상태, 순환기질환 병력 |

### 3. Korean Holter / long-term ECG 판독소견서 items

Mandatory items (급여기준 for E6556/E6557) [V]:
- 등록번호, 성명, 생년월일 또는 나이, 성별
- 기록시작일시, 기록종료일시, 판독일시
- 검사와 판독한 의사
- 검사 소견, 결론, 의료기관명

Customary content of Korean Holter reports [S, based on Korean hospital reports and the Japanese/US conventions below]:
- Analyzed duration and analyzable %; underlying rhythm.
- HR: min, mean and max with times; total beats.
- SVE/PAC: count, %, couplets, runs (longest/fastest SVT).
- VE/PVC: count, %, morphology, couplets, bigeminy/trigeminy, NSVT/VT runs.
- AF/AFL: burden %, longest episode, HR during AF.
- Pauses ≥2.0 s or ≥3.0 s (count, longest); AV block.
- ST deviation; HRV (SDNN etc., optional).
- Symptom/diary correlation; representative strips.
- 결론 and 권고.
- For multi-day patches: daily summary table plus whole-period summary.

---

## JAPAN (診療報酬 / レセプト)

The current fee schedule is the **令和8年度 (2026) 改定, 施行 2026-06-01**. 令和6 (2024) values are noted where they changed.
Note on numbering: the user's guessed codes are corrected here. D208 is 心電図検査, D210 is ホルター型, and D210-3 is 植込型心電図検査, not "長時間記録".

### 4. 点数表 codes (医科 第2章 第3部 検査, 第3節 生体検査料)

| 区分 | 名称 | 点数 (R8) | Key rules |
|---|---|---|---|
| D208 1 | 心電図検査 四肢単極誘導及び胸部誘導を含む最低12誘導 | 130 | 2 ベクトル心電図/体表ヒス束 150; 3 携帯型発作時心電図記憶伝達装置使用 150; 4 加算平均心電図による心室遅延電位測定 200; 5 その他(6誘導以上) 90. 注: 他医療機関で描写した心電図の診断 70点/回 |
| **D210** | **ホルター型心電図検査** 1: 30分又はその端数を増すごとに | 90 | Recording under 8h uses 1 |
| D210 2 | 8時間以上の場合 | **1,730** (R6: 1,750) | 注1 解析費用は所定点数に含む. Recording over 24h is still billed under "2" (one series). Discontinuous recordings are summed by time |
| D210 注2 (R8 新設) | **長時間心電図加算** (7日間以上実施) | **+320** (total 2,050) | New in 2026. Aimed at patch-type multi-day recorders |
| D210-2 | 体表面心電図、心外膜興奮伝播図 | 1,500 (unverified for R8) | |
| D210-3 | 植込型心電図検査 | 90 /30分又はその端数 | 施設基準 required. ILR analysis |
| D210-4 | T波オルタナンス検査 | 1,100 (unverified for R8) | |
| D212 | リアルタイム解析型心電図 | 600 | **入院中の患者以外**. 8h以上 monitoring with real-time analysis, recording only abnormal waveforms. 一連につき1回. Closest analogue to MCT |
| D212-2 | 携帯型発作時心電図記録計使用心電図検査 | 500 | Device recording ≥2 days continuously including pre-trigger ECG. 解析含む, 一連の使用で1回 |
| **D220** | 呼吸心拍監視、新生児心拍・呼吸監視、カルジオスコープ（ハートスコープ）、カルジオタコスコープ: 1 1時間以内又は1時間につき | 50 | Requires observing both the ECG curve and heart rate. The 観察結果の要点 must be recorded in the 診療録 |
| D220 2 | 3時間を超えた場合 (1日につき) イ 7日以内 | 150 | Day count starts from the first day billed. If the device is reapplied within 30 days of stopping, the original start date is kept. Days under 特定入院料 (ICU etc., where it is bundled) count toward the start date |
| D220 2 ロ | 7日を超え14日以内 | 130 | |
| D220 2 ハ | 14日を超えた場合 | 50 | Only the main item is billable when several D220 items are done the same day. Included in 人工呼吸 (J045) when done simultaneously |

**判断料**: ECG items (D208–D212-2, D220) have **no 生体検査判断料**. 判断料 apply to other groups such as D205 呼吸機能検査等判断料 and 脳波検査判断料. Interpretation is included in the item, except for the separate 70点 "他医描写心電図の診断".

Sources [V/S]:
- D210 (R8): https://knowlety.jp/ika/d210/ and https://shirobon.net/medicalfee/latest/ika/r08_ika/r08i_ch2/r08i2_pa3/r08i23_sec3/r08i233_cls1/r08i2331_D210.html
- 2026 change commentary: https://ecg.watson.jp/KEITAI/page25.html
- D208: https://knowlety.jp/ika/d208/
- D212: https://knowlety.jp/ika/d212/
- D212-2: https://knowlety.jp/ika/d212-2/
- D220: https://knowlety.jp/ika/d220/
- D210-3: https://clinicalsup.jp/jpoc/shinryou.aspx?file=ika_2_3_3_1/d210-3.html

Practical mapping:
- Outpatient 7–14 day patch: D210 "2" (1,730) + 長時間心電図加算 (320) = 2,050点, billed once per series. Patient cost at 3割 is about ¥6,150.
- Inpatient bedside or telemetry monitoring: D220 per day by tier, unless bundled in 特定入院料 or DPC.
- Ambulatory real-time (MCT-like) analysis: D212, 600点, outpatients only.
- Whether D210 and D220 can be billed on the same day for inpatients is not addressed in the sources found (unverified).

### 5. レセプト (診療報酬明細書) forms and fields

Governing notice: 「診療報酬請求書等の記載要領等について」(昭和51年保険発第82号), as amended by 令和6年3月27日 保医発0327第5号 [V]: https://www.mhlw.go.jp/content/12404000/001293320.pdf

**Form numbers** [V; this corrects the assumption in the request]
- 診療報酬**請求書** (the summary invoice): 様式第1(1) for 医科・歯科 入院・入院外併用, 様式第1(2) for 医科入院外. 様式第6 for 国保 and 様式第8 for 後期高齢 are separate.
- 診療報酬**明細書** (the per-patient レセプト): **様式第2(1) 医科入院** and **様式第2(2) 医科入院外**.
- One レセプト is written per patient, per month, per insurer (保険者). If the insurer or the 本人/家族 status changes within the month, a separate レセプト is needed.

**明細書 fields, in 記載要領 order**
1. 診療年月 (令和 年 月分)
2. **都道府県番号** (2桁) and **点数表番号** (1 = 医科)
3. **医療機関コード** (7桁)
4. 保険種別1 (1社・国 / 2公費 / 3後期 / 4退職), 保険種別2 (1単独/2併/3併), 本人・家族 (本人, 家族, 六歳, 高齢一般, 高齢7 etc.; 入院 vs 入院外 numbering)
5. **保険者番号** (8桁: 法別2 + 都道府県2 + 保険者3 + 検証1) and 給付割合
6. **被保険者証・被保険者手帳等の記号・番号** (with 枝番 2桁)
7. 公費負担者番号①② and 受給者番号①②; 区分
8. **氏名**, 男女区分, 生年月日
9. **職務上の事由** (船員保険: 1 職務上 / 2 下船後3月以内 / 3 通勤災害)
10. 特記事項 (codes such as 上位/一般/低所得)
11. 保険医療機関の所在地及び名称
12. **傷病名**: use the 傷病名 of 別添3 (the 傷病名マスター, i.e., MEDIS 標準病名 with 7-digit 傷病名コード, ICD-10 linked). List 主傷病 first, then 副傷病. If there are 4 or more, number them; overflow goes to 摘要
13. **診療開始日** (和暦)
14. **転帰** (治ゆ / 死亡 / 中止)
15. **診療実日数** (保険, 公費①, 公費②)
16. 点数欄 by 区分: 初診, 再診, 医学管理, 在宅, 投薬, 注射, 処置, 手術・麻酔, **検査・病理** (名称・回数・点数), 画像診断, その他, 入院
17. **摘要欄**: line items numbered by 診療識別 (e.g., "60" for 検査), with name, points × count, and required comments
18. **療養の給付**: 請求点数 (保険/公費), **一部負担金額** (入院外) or 負担金額 (入院), 減額 (割/円), 免除, 支払猶予

**Electronic レセプト (UKE / レセ電) record types** [V]: 記録条件仕様（医科用）令和8年8月版, https://shinryohoshu.mhlw.go.jp/shinryohoshu/file/spec/R08bt1_1_kiroku.pdf

| ID | Record | Key fields |
|---|---|---|
| IR | 医療機関情報 | 審査支払機関, 都道府県, 点数表(1=医科), 医療機関コード(7), 名称, 請求年月(西暦6), マルチボリューム, 電話 |
| RE | レセプト共通 | レセプト番号, レセプト種別 (e.g., 1111 医保単独本人入院, 1112 入院外), 診療年月, 氏名, 男女区分, 生年月日(西暦8), 給付割合, 入院年月日, 病棟区分, 一部負担金区分, 特記事項, カルテ番号, 検索番号 |
| HO | 保険者 | 保険者番号(8), 記号, 番号, 診療実日数, 合計点数, 食事療養回数/金額, 負担金額 |
| KO | 公費 | 公費負担者番号, 受給者番号, 実日数, 点数 |
| SN | 資格確認 | 枝番, 確認区分 (オンライン資格確認 / マイナ保険証) |
| JD | 受診日等 | 1–31 day flags |
| MF | 窓口負担額 | |
| GR | 包括評価対象外理由 | |
| SY | 傷病名 | 傷病名コード(7, uncoded = 0000999), 診療開始日, 転帰区分 (1 継続 / 2 治ゆ / 3 死亡 / 4 中止・転医), 修飾語コード, 傷病名称, 主傷病 (01), 補足コメント |
| SI | 診療行為 | 診療識別 (**60 = 検査・病理**), 負担区分, 診療行為コード(9), 数量, 点数, 回数, コメント, 算定日情報 1–31 |
| IY | 医薬品 | |
| TO | 特定器材 | |
| CO | コメント | コメントコード (9) + text |
| SJ | 症状詳記 | |
| GO | 診療報酬請求書 | totals |

診療識別 codes (別表20): 11 初診, 12 再診, 13 医学管理, 14 在宅, 21–28 投薬, 31–33 注射, 40 処置, 50 手術, 54 麻酔, **60 検査・病理**, 70 画像, 80 その他, 90/92 入院, 97 食事.
The 9-digit 診療行為コード for D210, the 長時間心電図加算, and D220 come from the 診療行為マスター (支払基金 / 診療報酬情報提供サービス). The actual codes were not retrieved (unverified). Look them up at https://shinryohoshu.mhlw.go.jp/.

Common 傷病名 (標準病名 → ICD-10):
- 発作性心房細動 / 持続性心房細動 / 心房細動 → I48.x
- 心房粗動 → I48.x
- 上室性期外収縮 → I49.1
- 心室性期外収縮 → I49.3
- 洞不全症候群 → I49.5
- 発作性上室頻拍 → I47.1
- 心室頻拍 → I47.2
- 房室ブロック → I44.x
- 動悸 → R00.2
- 失神 → R55
- めまい → R42
- 脳梗塞 → I63.x

The 7-digit 傷病名コード for each is in the MEDIS 標準病名マスター (codes not retrieved; unverified).

### 6. Japanese ホルター心電図 報告書 standard items

There is no single statutory template. Common items in clinical-lab practice and vendor reports [S]:
- Sources: https://www.kchnet.or.jp/for_medicalstaff/LI/item/LI_DETAIL_S10601.html and https://www.wakayama-med.ac.jp/hospital/shinryo/inspection/files/S007.pdf
- 患者ID, 氏名, 年齢, 性別, 依頼科・依頼医, 検査目的
- 記録開始・終了日時, 記録時間, 解析時間
- 基本調律
- **総心拍数**, 平均・最大・最小心拍数 (with times), 最大RR (ポーズ ≥2.0秒 or ≥3.0秒, count and longest), 最小RR
- **上室性期外収縮 (SVPC)**: 総数, %, 2連発, 連発 (最長・最速), 頻拍
- **心室性期外収縮 (VPC)**: 総数, %, 多形性, 2連発, 3連発以上 (NSVT), 二段脈, R on T, Lown分類
- 心房細動・粗動: 有無, 持続時間 or burden
- 房室ブロック, 洞房ブロック, 洞停止, 補充収縮
- **ST変化** (各CHの上昇・低下の最大値と時刻)
- HRV (optional)
- 行動記録・自覚症状 and the corresponding ECG
- 代表波形 (トレンドグラム, 圧縮波形)
- 所見 / 判定, 解析者 (臨床検査技師), 判読医 署名

Under the 2026 加算, a 7-day or longer recording is the billing condition, so the report should state the continuous recording period and any removal or gaps.

---

### Key caveats and unverified items
- EX871 detailed 세부인정기준 (co-billing with E6544, outpatient eligibility): not found. The product's 치료재료 billing for the patch device was not checked.
- Whether the 선별급여 status of E6556/E6557 changed after the 2025 re-evaluation: unverified. The 2026 HIRA book still lists both as 선별급여.
- The Korean 진료비 계산서·영수증 form number and the standard 본인부담 percentages are from memory.
- Japan R8 points for D210-2 and D210-4, and all 9-digit レセ電 診療行為コード and 7-digit 傷病名コード, were not retrieved.
