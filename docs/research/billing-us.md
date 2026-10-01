# US billing for ambulatory / wearable single-lead ECG: CPT, payer policies, ICD-10, CMS-1500/UB-04, report content

Researched 2026-10-01. Sources are listed per section. Items I could not confirm from a primary or near-primary source are marked **(unverified)**. CPT descriptors are AMA-copyrighted; the text below is copied from payer policies that reproduce them.

---

## 1. CPT codes

### 1.1 Code families and descriptors

The same structure applies to every family below:

- "Global" = recording + analysis + physician interpretation, billed as one code.
- The components have **their own CPT codes**. These are **not** global codes split with modifiers. CMS lists the global codes as "global only", the recording/scanning codes as "technical component only", and the interpretation codes as "professional component only".
- **Do not append -26 or -TC** to 93224–93229, 93241–93248 or 93268–93272. WPS article A57476 says so explicitly. Bill the matching component code instead.

| Code | Descriptor (abridged only where marked …) | Component | Applies when |
|---|---|---|---|
| **93224** | External electrocardiographic recording up to 48 hours by continuous rhythm recording and storage; includes recording, scanning analysis with report, review and interpretation by a physician or other QHP | Global only | Continuous recording ≤48 h, one entity does everything |
| 93225 | … up to 48 hours …; recording (includes connection, recording, and disconnection) | Technical | Hook-up/recording only |
| 93226 | … up to 48 hours …; scanning analysis with report | Technical | Scanning/analysis lab (IDTF/vendor) |
| 93227 | … up to 48 hours …; review and interpretation by a physician or other QHP | Professional | Reading physician |
| **93241** | External electrocardiographic recording for more than 48 hours up to 7 days by continuous rhythm recording and storage; includes recording, scanning analysis with report, review and interpretation | Global only | >48 h to 7 days continuous (patch) |
| 93242 | … >48 h up to 7 days …; recording (includes connection and initial recording) | Technical | |
| 93243 | … >48 h up to 7 days …; scanning analysis with report | Technical | |
| 93244 | … >48 h up to 7 days …; review and interpretation | Professional | |
| **93245** | External electrocardiographic recording for more than 7 days up to 15 days by continuous rhythm recording and storage; includes recording, scanning analysis with report, review and interpretation | Global only | >7 to 15 days continuous |
| 93246 | … >7 up to 15 days …; recording (includes connection and initial recording) | Technical | |
| 93247 | … >7 up to 15 days …; scanning analysis with report | Technical | |
| 93248 | … >7 up to 15 days …; review and interpretation | Professional | |
| 0937T–0940T | External electrocardiographic recording for greater than 15 days up to 30 days by continuous rhythm recording and storage. 0937T global; 0938T recording; 0939T scanning analysis with report; 0940T review and interpretation | Cat III (effective 01/01/2025) | >15 to 30 days continuous. No national Medicare price (contractor-priced) |
| **93228** | External mobile cardiovascular telemetry with electrocardiographic recording, concurrent computerized real time data analysis and greater than 24 hours of accessible ECG data storage (retrievable with query) with ECG triggered and patient selected events transmitted to a remote attended surveillance center for up to 30 days; review and interpretation with report by a physician or other QHP | Professional | MCT/MCOT physician |
| **93229** | … same stem …; technical support for connection and patient instructions for use, attended surveillance, analysis and transmission of daily and emergent data reports as prescribed by a physician or other QHP | Technical | MCT provider (IDTF/vendor) with a 24/7 attended monitoring center |
| **93268** | External patient and, when performed, auto activated electrocardiographic rhythm derived event recording with symptom-related memory loop with remote download capability up to 30 days, 24-hour attended monitoring; includes transmission, review and interpretation by a physician or other QHP | Global only | Event/external loop recorder, ≤30 days |
| 93270 | … ; recording (includes connection, recording, and disconnection) | Technical | |
| 93271 | … ; transmission and analysis | Technical | |
| 93272 | … ; review and interpretation by a physician or other QHP | Professional | |
| 93285 | Programming device evaluation (in person) with iterative adjustment …; subcutaneous cardiac rhythm monitor system | Prof. (ILR) | Shown for contrast: implantable loop recorder (ILR) programming |
| 93291 | Interrogation device evaluation (in person) …; subcutaneous cardiac rhythm monitor system, including heart rhythm derived data analysis | ILR | In-person ILR interrogation |
| 93298 | Interrogation device evaluation(s), (remote) up to 30 days; subcutaneous cardiac rhythm monitor system, including analysis of recorded heart rhythm data, analysis, review(s) and report(s) | ILR prof. | Remote ILR, per 30 days (technical part billed as G2066 (unverified)) |
| 33285 / 33286 | Insertion / removal, subcutaneous cardiac rhythm monitor | ILR | |

### 1.2 Duration, frequency and bundling rules

- **Choosing the code by duration.** Pick the code from the **actual continuous recording time**: ≤48 h → 93224–93227; >48 h to 7 d → 93241–93244; >7 to 15 d → 93245–93248; >15 to 30 d → 0937T–0940T. A patch prescribed for 14 days that records only 40 h is billed as a Holter (93224 family), not as 93241. AAPC puts it this way: "always check the medical documentation to see how long … the ECG recording" ran.
- **Under 12 hours.** For a Holter recording of less than 12 hours continuous, append modifier **-52** (WPS A57476).
- **Analyzable time.** I found no CPT or Medicare minimum for analyzable (non-artifact) time **(unverified)**. Payers and auditors still compare the reported hours with the code, so report both total and analyzable time.
- **MCT (93228/93229).** "Report CPT codes 93228 and 93229 only once per 30 days" (Novitas A59268). An episode of 1–30 consecutive days = **1 unit**. Date of service = **the date the patient was first placed on the monitor**, and further claims in the same episode are denied (WPS A57476). The receiving station must be staffed 24 hours a day by at least an EKG technician (Noridian LCD L40255).
- **Event recorders (93268–93272).** Up to 30 days, 1 unit per episode.
- **No overlap between device types.** Noridian A60279 (effective 06/21/2026): "Do not report 93241, 93242, 93243, 93244 in conjunction with 93224–93229, 93245–93248" for the same monitoring period. LCD L40255: "Tests cannot be billed during any period that overlaps with the billing timeframe of another device." WPS: on the same dates, bill either the wearable monitor or the ≤48-h monitor, not both.
- **Repeat testing (Noridian L40255).** "Testing for more than 30 consecutive days is only rarely medically necessary." A negative 30-day test is not enough justification to repeat it, and a second test within a year is "unlikely" to be necessary. Aetna sends any repeat study within 1 year to medical-necessity review.
- **Holter date of service.** For global 93224, use the date of physician review. For 93225/93226/93227, use the date each component was performed (WPS A57476). For 93241–93248, A57476 gives no date-of-service rule; check your MAC **(unverified)**.
- **Interpreting physician.** WPS requires the interpreting physician to be identified on the claim. An IDTF can bill the technical codes. If the IDTF also bills the professional code, it needs a reassignment from the physician.

### 1.3 Medicare Physician Fee Schedule national payment

The 2026 conversion factor is $33.4009 (non-qualifying APM) and $33.5675 (qualifying APM participants), per the ACC summary of the 2026 final rule.

The amounts below come from a third-party mirror of the CMS fee schedule (medfeeschedule.com). Each one equals total RVU × CF (for example, 93241: 8.36 × 33.4009 = $279.23), but confirm in the CMS PFS Look-up Tool. Facility and non-facility amounts are the same for these codes. Global codes are not payable in the facility setting: in a hospital, the physician bills the professional code and the hospital bills the technical code on the UB-04.

| Code | 2025 national | 2026 national | 2026 total RVU |
|---|---|---|---|
| 93224 (global) | $68.25 | $70.48 | 2.11 |
| 93225 / 93226 / 93227 | $17.47 / $33.32 / $17.47 | $18.04 / $34.74 / $17.70 | 0.54 / 1.04 / 0.53 |
| 93241 (global) | $259.74 | $279.23 | 8.36 |
| 93242 / 93243 / 93244 | $11.32 / $226.43 / $22.00 | $11.69 / $244.83 / $22.71 | 0.35 / 7.33 / 0.68 |
| 93245 (global) | $270.42 | $289.59 | 8.67 |
| 93246 / 93247 / 93248 | $11.32 / $234.84 / $24.26 | $11.69 / $253.18 / $24.72 | 0.35 / 7.58 / 0.74 |
| 93228 (prof) | $24.26 | $25.05 | 0.75 |
| 93229 (tech) | $744.62 | $758.53 | 22.71 |
| 93268 (global) | $163.35 | $169.68 | 5.08 |
| 93270 / 93271 / 93272 | $7.76 / $132.62 / $22.97 | $8.35 / $137.61 / $23.71 | 0.25 / 4.12 / 0.71 |
| 93285 / 93291 / 93298 | $56.93 / $46.58 / $97.69 | $59.45 / $48.10 / $103.21 | — |
| 0937T–0940T | contractor-priced | contractor-priced | — |

Hospital outpatient (OPPS, technical codes on the UB-04), 2024 national rates from Boston Scientific: 93229 APC 5721 $148.98; 93225/93226 APC 5734 $116.11; 93270 APC 5741 $35.98; 93271 APC 5742 $92.35. 2026 OPPS amounts were not verified **(unverified)**.

Sources:
- [Cigna MCP 0547 (reproduces CPT descriptors)](https://static.cigna.com/assets/chcp/pdf/coveragePolicies/medical/mm_0547_coveragepositioncriteria_implantable_electrocardiographic_event_monitors.pdf)
- [UHC MA MMP109.19](https://www.uhcprovider.com/content/dam/provider/docs/public/policies/medadv-mp/ambulatory-ecg-monitoring.pdf)
- [WPS A57476](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57476)
- [Novitas A59268](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=59268)
- [Noridian A60279](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=60279)
- [Noridian LCD L40255](https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=40255)
- [AAPC CPT 2021 article](https://www.aapc.com/codes/coding-newsletters/my-cardiology-coding-alert/cpt-2021-part-1-sort-through-these-congenital-transcatheter-ventricular-assist-device-and-ecg-recording-codes-before-jan-1-hits-165306-article)
- [Boston Scientific 2024 coding quick reference](https://www.cdx.bostonscientific.com/content/dam/bostonscientific/ep/preventice/Cardiac%20Monitoring%20Coding%20and%20Payment%20Quick%20Reference.pdf)
- [medfeeschedule.com, e.g. 93241](https://www.medfeeschedule.com/code/93241)
- [ACC 2026 PFS final rule](https://www.acc.org/Latest-in-Cardiology/Articles/2025/11/06/12/51/Dive-Into-the-2026-Medicare-Physician-Fee-Schedule-Final-Rule)

---

## 2. Largest insurers and their policies

**Which four are largest.** The 2025 ranking of total enrollment, covering commercial, Medicaid and Medicare Advantage (Becker's, ~320M enrollments), is:

1. UnitedHealth Group, 44.8M
2. Elevance Health, 36.1M
3. CVS Health/Aetna, 24.9M
4. Centene, 19.0M
5. HCSC, 18.7M
6. Cigna, 16.2M

So Cigna is **not** in the top four; Centene is. Below I cover all five: the top four plus Cigna, since you named it. Source: [Becker's 2025](https://www.beckerspayer.com/rankings-ratings/top-10-largest-insurers-by-enrollment-in-2025/). I saw the figures only in the search snippet; the page itself returned 403.

### 2.1 UnitedHealthcare

**Commercial / Individual Exchange: "Implantable Loop Recorders and Wearable Heart Rhythm Monitors"**
- Policy **2026T0489JJ**, effective 05/01/2026: [PDF](https://www.uhcprovider.com/content/dam/provider/docs/public/policies/index/commercial/implantable-recorders-wearable-monitors-05012026.pdf). It was formerly titled "Cardiac Event Monitoring" (2025 version 2025T0489GG).
- The current text covers **only ILRs and consumer devices**:
  - ILRs are medically necessary when noninvasive monitoring is contraindicated or was nondiagnostic after **≥2 weeks**, for cryptogenic stroke/suspected paroxysmal AF, ventricular arrhythmia, structural/infiltrative disease, unexplained infrequent syncope, post-CTI ablation with CHA₂DS₂-VASc ≥2, AF found during acute illness or surgery, or abnormal EP/tilt testing.
  - Consumer ECG devices (watch/phone) are not medically necessary.
  - Codes listed: 0650T, 33285, 33286, 93285, 93291, 93297, 93298, 0902T, 93799, E0616, E1399.
  - Not applicable to members under 18.
- **External Holter, patch, event and MCT criteria no longer appear** in this commercial policy. The 2025 version listed "Ambulatory Event Monitoring (Holter, event, patch) and Outpatient Cardiac Telemetry" as proven. Which criteria UHC now applies to external monitors for commercial members (InterQual or other) is **unverified**.
- Documentation: refer to UHC's "Medical Records Documentation Used for Reviews" protocol.

**Medicare Advantage: "Ambulatory Electrocardiographic (AECG) Monitoring"**
- Policy **MMP109.19**, effective 09/01/2026: [PDF](https://www.uhcprovider.com/content/dam/provider/docs/public/policies/medadv-mp/ambulatory-ecg-monitoring.pdf).
- It defers to NCD 20.15 and the MAC LCDs/LCAs. Where no LCD exists, AECG with an **FDA-cleared** device is reasonable and necessary when a 12-lead ECG, history and exam have not explained the complaints, and also for:
  - syncope/near-syncope, dizziness, chest pain, palpitations, dyspnea
  - nocturnal arrhythmia; bradycardia
  - AF rate control
  - starting, changing or stopping antiarrhythmic drugs; post-ablation
  - after ACS; pre/post ICD reprogramming
  - silent ischemia
  - PVC/NSVT in HCM, ARVC, long QT, DCM, congenital heart disease or Brugada
  - cryptogenic stroke; pre/post-TAVR
- Note in the policy: "A 24–48 hour monitor is most appropriate for patients with daily or near daily symptoms."
- Not covered: non-FDA-cleared devices, and 24-hour monitoring stations that do not meet the definition.
- Codes: 93224–93229, 93241–93248, 93268–93272, 0937T–0940T, 33285, E0616, with an extensive covered ICD-10 list.
- Prior authorization: not stated in either policy **(unverified)**. Check the UHC Commercial Advance Notification/PA list for your state and plan.

### 2.2 Elevance Health (Anthem)

**CG-MED-40 "External Ambulatory Cardiac Monitors"** (Clinical UM Guideline)
- Effective **04/15/2026**, last MPTAC review 02/19/2026: [link](https://www.anthem.com/medpolicies/abc/active/gl_pw_a053673.html).
- **Holter (24–48 h)** is medically necessary for:
  - frequent unexplained palpitations, dizziness or syncope
  - HCM/DCM
  - ventricular arrhythmia, QT or ST risk assessment
  - antiarrhythmic response
  - paroxysmal AF after cryptogenic stroke
  - asymptomatic AF ≥3 months post-ablation
  - pacemaker/ICD function
  - variant angina
  - separate pediatric criteria
- Holter is not medically necessary for diabetic autonomic neuropathy or for post-MI with EF ≤40%.
- **External event monitors (93241–93248, 93268–93272)** are medically necessary as:
  - the diagnostic alternative to Holter when symptoms are infrequent (less than every 48 h)
  - paroxysmal AF detection after cryptogenic stroke when a Holter was inconclusive
  - post-stroke monitoring, added 02/2026: when considering stopping anticoagulation; when AF ≥5 min would change anticoagulation based on CHA₂DS₂-VASc; or **2–4 weeks** of monitoring after a stroke from large/small-vessel or indeterminate cause
- Event monitors are not medically necessary for antiarrhythmic-efficacy or ischemia monitoring, or for post-ablation AF monitoring.
- Durations: Holter 24–48 h; 93241–93244 up to 7 d; 93245–93248 up to 15 d; 93268–93272 up to 30 d.
- Codes: 93224–93227, 93241–93248, 93268–93272, and 93799 for in-office connection/review without 24-hour attended monitoring.

**CG-MED-74 "Implantable Ambulatory Event Monitors and Mobile Cardiac Telemetry"**
- I read the 06/28/2023 version on a third-party mirror ([genhealth.ai](https://genhealth.ai/policy/anthem-bluecross-ct/995e2111-cg-med-74-implantable-ambulatory-event-monitors-and-mobile-cardiac-telemetry)). The current Anthem URL returned 404, so the current text is **unverified**.
- **MCT criteria** (both required):
  1. symptoms suggestive of arrhythmia less often than once every 48 h, **or** suspected paroxysmal AF after cryptogenic stroke to guide anticoagulation; **and**
  2. a **non-diagnostic external event-monitoring trial of ≥14 continuous days**.

Prior authorization at Anthem depends on the state plan and is **unverified**.

### 2.3 CVS Health / Aetna

**CPB 0073 "Cardiac Event Monitors"**: [link](https://www.aetna.com/cpb/medical/data/1_99/0073.html). Holter is covered separately in [CPB 0019 "Holter Monitors"](https://www.aetna.com/cpb/medical/data/1_99/0019.html).

Covered indications:
- **External loop/event recorders:** suspected arrhythmia when Holter/48-h monitoring was non-diagnostic or symptoms occur less than daily; ST-depression for suspected ischemia; benefit after starting an antiarrhythmic; recurrence after stopping a drug; post-ablation; syncope/lightheadedness.
- **Long-term external ECG >48 h (patch; 93241–93248):** syncope/lightheadedness or arrhythmia documentation when prior testing was non-diagnostic or symptoms are infrequent.
- **MCT (93228/93229):** recurrent unexplained presyncope, syncope, palpitations or dizziness when arrhythmia is suspected and prior monitoring was non-diagnostic or symptoms are infrequent; or suspected AF as the cause of cryptogenic stroke.
- **ILR:** includes the case after a non-diagnostic 30-day MCT in cryptogenic stroke, and after typical-flutter ablation with HATCH ≥2.

Limits and exclusions:
- "Requests for repeat studies within 1 year of a previous study are subject to medical necessity review."
- Experimental: KardiaMobile, BodyGuardian, iHEART, ViSi Mobile, CardioPatch, self-monitoring ECG devices, and Zio for post-drug-therapy response.

Codes: 93268, 93270–93272, 0937T–0940T, 93228, 93229, 93241–93248, 33285, 33286, 93285, 93291, 93298, 0650T, C1764, E0616.

ICD-10 examples: I47.0–I49.9, I63.x, R55, R42, R00.2, Z86.73.

Precertification: not stated in the CPB **(unverified)**.

### 2.4 Centene (Ambetter, WellCare, Health Net, Medicaid plans)

**CP.MP.113 "Holter Monitors"**: [Health Net copy](https://www.healthnet.com/content/dam/centene/policies/clinical-policies/CP.MP.113.pdf). That copy shows "date of last revision 4/23"; other affiliates post later revisions.

- Holter for 24–48 h is medically necessary.
  - **Adults (>18):** unexplained syncope, near-syncope, dizziness, palpitations, dyspnea or chest pain; neuro events with suspected AF/flutter; cardiomyopathy or first-degree relative with ARVC; long QT; Brugada; antiarrhythmic efficacy or proarrhythmia; pacemaker/ICD function; variant angina; HF with suspected arrhythmia; post-ablation.
  - **Pediatric (≤18):** a separate list.
- Codes: 93224–93227.
- "For Holter monitoring beyond 48 hours, see clinical decision support criteria." Ambetter states that it uses **InterQual** wherever no Centene policy exists, so extended patch monitoring, event monitors and MCT are reviewed under InterQual.
- One secondary source states that Ambetter requires prior auth for MCT 93228/93229 **(unverified)**.

### 2.5 Cigna (6th by enrollment)

**Medical Coverage Policy 0547 "Ambulatory External and Implantable Electrocardiographic Monitoring"**
- Effective **09/15/2026**, next review 11/15/2026: [PDF](https://static.cigna.com/assets/chcp/pdf/coveragePolicies/medical/mm_0547_coveragepositioncriteria_implantable_electrocardiographic_event_monitors.pdf). It covers everything except Holter.
- **External monitoring, 48 h to 30 days (93241–93248, 93268, 93270–93272, 0937T–0940T)** is medically necessary for any of:
  - presyncope, syncope or severe palpitations with suspected significant brady- or tachyarrhythmia
  - AF rate/rhythm evaluation that will change management (pre/post ablation)
  - stroke/TIA of undetermined cause (93268–93272 only)
  - after CTI ablation, not anticoagulated, CHA₂DS₂-VASc ≥2
  - HCM
  - AF-induced cardiomyopathy with recovered EF
  - AF found during acute illness or surgery with stroke risk factors
- Not covered for any other indication, **including ST-segment analysis**.
- **MCT (93228/93229)** requires that **ambulatory external monitoring was non-diagnostic** plus one of the same indications. This makes MCT second-line at Cigna.
- **ILR:** requires ≥14 days of non-diagnostic noninvasive monitoring.
- Consumer devices are not covered.
- **Diagnosis-code gating.** Cigna's instructions state that claims without a covered ICD-10 code from the policy's list will be denied.
- Prior authorization: not stated in the policy. Cigna cardiology utilization management is delegated to a vendor (eviCore), but whether that covers rhythm monitors is **unverified**.

---

## 3. Commonly supported ICD-10-CM codes

Every code below appears in at least one of the policies or articles cited (Noridian A60279, UHC MA MMP109.19, WPS A57476, Aetna CPB 0073, or Cigna 0547 by category). Check the exact covered list for each payer and MAC. The FY2027 ICD-10-CM update takes effect today (10/01/2026), and code validity under it is **unverified**.

| Code | Descriptor |
|---|---|
| R00.0 | Tachycardia, unspecified |
| R00.1 | Bradycardia, unspecified |
| R00.2 | Palpitations |
| R55 | Syncope and collapse |
| R42 | Dizziness and giddiness |
| R07.9 | Chest pain, unspecified **(listed in some LCDs; unverified for each payer)** |
| I48.0 | Paroxysmal atrial fibrillation |
| I48.11 / I48.19 | Longstanding persistent / other persistent atrial fibrillation |
| I48.20 / I48.21 | Chronic atrial fibrillation, unspecified / permanent |
| I48.91 | Unspecified atrial fibrillation |
| I48.92 | Unspecified atrial flutter |
| I47.10 / I47.19 | Supraventricular tachycardia, unspecified / other SVT (I47.1 subdivided FY2023) |
| I47.20 | Ventricular tachycardia, unspecified |
| I49.1 | Atrial premature depolarization |
| I49.3 | Ventricular premature depolarization |
| I49.5 | Sick sinus syndrome |
| I49.9 | Cardiac arrhythmia, unspecified |
| I44.1 / I44.2 | Atrioventricular block, second degree / complete |
| I45.81 | Long QT syndrome |
| I42.0 / I42.1 / I42.2 | Dilated / obstructive hypertrophic / other hypertrophic cardiomyopathy |
| I25.6 | Silent myocardial ischemia |
| I63.9 | Cerebral infarction, unspecified (cryptogenic stroke work-up) |
| G45.9 | Transient cerebral ischemic attack, unspecified |
| Z86.73 | Personal history of TIA and cerebral infarction without residual deficits |
| Z86.74 | Personal history of sudden cardiac arrest |
| Z95.0 | Presence of cardiac pacemaker |

Coding notes:
- Code the symptom (R00.2, R55) when no diagnosis has been established at ordering time.
- Code the arrhythmia when monitoring an established condition, for example AF rate control or a post-ablation check.
- Cigna and many MAC articles deny claims whose diagnosis is not on the covered list.

---

## 4. Claim forms

### 4.1 CMS-1500 (02/12)

Box names follow the NUCC 1500 Reference Instruction Manual v13.0 (07/2025), the latest available; no v14 was found. Medicare and payers may add their own rules.

| Box | NUCC title | What to enter for an ambulatory ECG service |
|---|---|---|
| 1 | Medicare, Medicaid, TRICARE, CHAMPVA, Group Health Plan, FECA, Black Lung, Other | X in one payer-type box |
| 1a | Insured's ID Number | Member ID exactly as on the card |
| 2 | Patient's Name | Last, First, MI |
| 3 | Patient's Birth Date, Sex | MM DD YYYY; X for M/F |
| 4 | Insured's Name | Subscriber name (Medicare: leave blank if the patient is the insured) |
| 5 | Patient's Address | Street, city, state, ZIP, phone |
| 6 | Patient Relationship to Insured | Self / Spouse / Child / Other |
| 7 | Insured's Address | If Box 4 is completed |
| 8 | Reserved for NUCC Use | Blank |
| 9, 9a, 9d | Other Insured's Name / Policy or Group No. / Plan Name | Secondary coverage, only if 11d = Yes |
| 9b, 9c | Reserved for NUCC Use | Blank |
| 10a–c | Is Patient's Condition Related To: Employment / Auto Accident (state) / Other Accident | Normally all "No" |
| 10d | Claim Codes (Designated by NUCC) | Usually blank (Medicaid condition codes when required) |
| 11 | Insured's Policy, Group, or FECA Number | Group number (Medicare: "NONE" if no primary other than Medicare) |
| 11a | Insured's Date of Birth, Sex | |
| 11b | Other Claim ID (Designated by NUCC) | Usually blank |
| 11c | Insurance Plan Name or Program Name | |
| 11d | Is there another Health Benefit Plan? | Y/N; if Y complete 9, 9a, 9d |
| 12 | Patient's or Authorized Person's Signature | "SOF" (signature on file) |
| 13 | Insured's or Authorized Person's Signature | "SOF" (authorizes payment to the provider) |
| 14 | Date of Current Illness, Injury, or Pregnancy (LMP) | Onset of symptoms, with qualifier 431 (optional for diagnostics) |
| 15 | Other Date | Usually blank |
| 16 | Dates Patient Unable to Work | Blank |
| 17 / 17a / 17b | Name of Referring Provider or Other Source / Other ID / NPI | **Ordering physician**, qualifier **DK** (ordering) or DN (referring), plus the ordering NPI. Diagnostic tests require an ordering provider |
| 18 | Hospitalization Dates Related to Current Services | Admission/discharge dates if the patient is an inpatient |
| 19 | Additional Claim Information | Payer-specific. For 0937T–0940T or 93799, a narrative such as "Patch ECG 21 days" |
| 20 | Outside Lab? $Charges | "Yes" plus the purchase price if the billing provider bought the technical component under purchased-service rules (otherwise No) |
| 21 | Diagnosis or Nature of Illness or Injury | **ICD indicator "0" (ICD-10-CM)**. Up to 12 codes in **A–L**, no decimal point, most specific first, e.g. A = R002, B = R55, C = I480 |
| 22 | Resubmission and/or Original Reference Number | Frequency code 7 (replacement) or 8 (void) plus the original claim number, when correcting |
| 23 | Prior Authorization Number | PA/referral number if obtained (also used for the IDTF CLIA field in some cases) |
| 24A | Date(s) of Service | From/To. **MCT:** the hook-up date (single date, 1 unit). **Holter global:** the physician-review date. **Patch:** follow your MAC; From = start and To = end is common practice **(unverified)** |
| 24B | Place of Service | **11** office; **19** off-campus outpatient hospital; **22** on-campus outpatient hospital; **21** inpatient hospital (professional component only); **12** home. For IDTF/home-worn monitors, check payer and MAC rules **(unverified)** |
| 24C | EMG | Usually blank |
| 24D | Procedures, Services, or Supplies (CPT/HCPCS + up to 4 modifiers) | E.g. 93241 (global, office). In a hospital: physician 93244 and hospital 93242/93243 on the UB-04. MCT: 93228 physician, 93229 IDTF. Modifiers: **52** for Holter <12 h; GA/GY/GZ for ABN; 59/XU only if allowed. **Never 26/TC on these codes** |
| 24E | Diagnosis Pointer | Letter(s) A–L from Box 21, primary first (e.g. "AB") |
| 24F | $Charges | The provider's billed charge for the line |
| 24G | Days or Units | **1** (one study/episode) |
| 24H | EPSDT/Family Plan | Medicaid only |
| 24I | ID Qualifier | Shaded: qualifier for a non-NPI ID (e.g. 0B, 1G) if the payer requires it |
| 24J | Rendering Provider ID # | Unshaded: **NPI of the interpreting physician**. WPS requires the interpreting physician to be identified |
| 25 | Federal Tax I.D. Number | EIN (or SSN), with the box checked |
| 26 | Patient's Account No. | Internal account/encounter ID (comes back on the remittance) |
| 27 | Accept Assignment? | Yes/No (Medicare participating = Yes) |
| 28 | Total Charge | Sum of 24F |
| 29 | Amount Paid | Patient/other-payer payments |
| 30 | Reserved for NUCC Use | Blank |
| 31 | Signature of Physician or Supplier Including Degrees or Credentials | Signature or "SOF" plus date |
| 32 / 32a / 32b | Service Facility Location Information / NPI / Other ID | Where the service was performed (clinic, hospital department, IDTF). 32a = facility NPI |
| 33 / 33a / 33b | Billing Provider Info & Ph # / NPI / Other ID | Billing entity name, address (no PO box), phone; 33a = group/billing NPI |

Electronic claims use the equivalent ANSI X12 **837P** (5010A1) loops.

### 4.2 UB-04 (CMS-1450) for hospital/facility billing

Use the UB-04 / 837I when the **hospital** bills the technical component:

- **Outpatient:** type of bill **013X** (hospital outpatient). The physician separately bills the professional code (93227/93244/93248/93228/93272) on a CMS-1500 with POS 19 or 22.
- **Inpatient (TOB 011X):** monitoring is bundled into the DRG. Only the physician's professional component is billed separately (POS 21).

Revenue codes **073X EKG/ECG**:

| Revenue code | Meaning |
|---|---|
| 0730 | General classification |
| **0731** | **Holter monitor** |
| **0732** | **Telemetry** |
| 0739 | Other EKG/ECG |

Note that 0731 is Holter, not telemetry. Which revenue code a payer expects for MCT (0732 vs 0731) and for patch codes is payer-specific **(unverified)**.

| Form locator (FL) | Content |
|---|---|
| FL1 | Billing provider name/address |
| FL3a/b | Patient control number / medical record number |
| FL4 | Type of bill (e.g. 0131) |
| FL5 | Federal tax number |
| FL6 | Statement covers period (from/through) |
| FL8–11 | Patient name, address, birthdate, sex |
| FL12–17 | Admission data (inpatient) |
| FL42 | Revenue code (0731 etc.) |
| FL43 | Description |
| FL44 | **HCPCS/CPT + modifiers** (e.g. 93243) |
| FL45 | Service date |
| FL46 | Units (1) |
| FL47 | Total charges |
| FL50 | Payer |
| FL56 | Billing NPI |
| FL58–62 | Insured name / relationship / ID / group |
| FL63 | Treatment authorization code |
| FL66 | Diagnosis version qualifier (0) |
| FL67 | Principal diagnosis |
| FL67A–Q | Other diagnoses |
| FL76 | Attending provider NPI |
| FL78–79 | Other provider (e.g. interpreting physician) |

Sources:
- [NUCC 1500 manual v13 (07/2025)](https://www.nucc.org/images/stories/PDF/1500_claim_form_instruction_manual_2025_07-v13.pdf)
- [WPS A57476](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57476)
- [UB-04 073X revenue codes (findacode)](https://www.findacode.com/ub04-revenue/ub04-revenue-cms-1450-codes-07-group.html)
- [Boston Scientific OPPS/PFS reference](https://www.cdx.bostonscientific.com/content/dam/bostonscientific/ep/preventice/Cardiac%20Monitoring%20Coding%20and%20Payment%20Quick%20Reference.pdf)

---

## 5. What the ambulatory ECG report must contain to support billing

No single US rule lists every report field. The list below combines the CPT code definitions, MAC articles, a CPT Assistant description, and the 2017 ISHNE-HRS expert consensus. Each code's descriptor names a "scanning analysis **with report**" (technical) and a "review and interpretation" (professional). Both must exist in the record for the corresponding code to be billed.

**Required or expected by payers and MACs**
- Patient identifiers, ordering provider, **indication/diagnosis** consistent with the claim's ICD-10 codes. Novitas A59268: specific symptoms or cardiac history, plus justification for the type of monitor selected.
- **Device/service type and monitoring period:** hook-up date/time, end date/time, **total recording duration (hours/days)**. Duration drives code selection: ≤48 h, >48 h–7 d, >7–15 d, >15–30 d, MCT 30-day episode.
- **Physician interpretation** with the interpreting physician's name, legible **signature and date** (Novitas: "interpretation with physician name"; legible identifiers and signature). For a Holter global, the review date is the date of service (WPS).
- **MCT / event monitors (attended monitoring):** for each transmission, Novitas requires patient name, diagnosis, **transmission date/time**, channel, **PR/QRS intervals when abnormal, heart rate, rhythm, reported symptoms, and any physician notification/action taken**. WPS lists documentation of hook-up, transmissions, analysis, chart notes, equipment maintenance and supplies for 93228/93229.
- **Daily reports for MCT** are part of the 93229 descriptor ("transmission of daily and emergent data reports as prescribed").

**Expected clinical content.** Per CPT Assistant (as quoted in search results; not read directly), the physician reviews each 24-hour summary, covering:
1. heart-rate trends (min/max/avg) awake and asleep
2. tabular summary of supraventricular and ventricular ectopy
3. technician-flagged arrhythmias
4. pauses/bradyarrhythmias
5. diary symptoms with correlative findings

Recommended field set for a daily (and end-of-study) report:

| Section | Fields |
|---|---|
| Recording | Start/stop timestamps; total hours; **analyzable hours/%** (artifact/lead-off excluded); device/lead (single-lead patch); days with data |
| Heart rate | Min / avg / max with **timestamps** (and day/night averages); HR trend |
| Rhythm | Underlying rhythm(s); conduction (PR, QRS, QT/QTc where measurable on single lead) |
| AF/AFL | Present Y/N; **burden %** (time in AF ÷ analyzable time); number of episodes; longest episode (duration, start time); ventricular rate in AF (min/avg/max) |
| Supraventricular | **PAC count and % of total beats**; couplets, runs; SVT episodes (count, longest, fastest rate) |
| Ventricular | **PVC count and %**; morphologies if available; couplets, bigeminy/trigeminy; NSVT/VT episodes (beats, rate, time) |
| Brady/pauses | **Longest pause (seconds, timestamp)**; pauses ≥2.0 s / ≥3.0 s count; AV block (2nd-degree Mobitz I/II, complete) episodes; sustained bradycardia |
| Patient events | Each symptom trigger/diary entry: time, symptom, **rhythm at that time** (symptom–rhythm correlation), plus whether any arrhythmia occurred without symptoms |
| Strips | Representative strips: baseline, min HR, max HR, longest pause, each significant arrhythmia, each symptomatic event (with time stamps and scale) |
| Notifications (MCT) | Urgent findings sent to the physician: time, criterion, who was notified, action |
| Interpretation | Physician summary and conclusion, comparison with prior studies, recommendations; **name, credentials, electronic signature, date/time** |

Notification thresholds for MCT, ISHNE-HRS Table 6 (example criteria):
- **Emergency:** sustained wide-complex tachycardia at ≥160 bpm; prolonged asystole.
- **Within 24 h:**
  - WCT <160 bpm
  - symptomatic SVT ≥150 bpm
  - symptomatic pause ≥4 s
  - Mobitz II or 3rd-degree AV block
  - any syncope
  - pacemaker malfunction; ICD discharge
  - symptomatic HR ≤30 bpm
- **Office hours:** new AF/flutter ≥30 s or AF with ventricular rate ≥150 bpm for 60 s; WCT ≥120 bpm from 3 beats to 30 s; Mobitz I.
- The ≥/≤ signs were lost in PDF extraction and were restored from context, so treat the exact inequality directions as **unverified**.

Sources:
- [Novitas A59268](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=59268)
- [WPS A57476](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57476)
- [Noridian L40255](https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=40255)
- [2017 ISHNE-HRS consensus (Heart Rhythm)](https://www.heartrhythmjournal.com/article/s1547-5271(17)30415-0/fulltext) ([PDF copy](https://www.heartuniversity.org/wp-content/uploads/ISHNE-HRS-2017-Expert-Consensus-Ambulatory-ECG-and-ExternalCcardiac-Monitoring-and-Telemetry.pdf))
- CPT Assistant description via [AAPC](https://www.aapc.com/codes/cpt_assistant/download_pdf_cpt_assistant/3589) **(page not directly readable)**

---

## 6. Points that matter for the product

1. **Inpatients wearing patches** (POS 21, TOB 011X): the technical service is bundled into the DRG. At most, a physician bills a professional-component code (e.g. 93227/93244/93248). The **daily inpatient report generally earns nothing separately**. Claim generation matters for outpatients and MCOT.
2. **One claim per study, not per day.** MCT = 1 unit per ≤30-day episode, dated at hook-up. Patch codes = 1 unit per study, chosen by total duration. Daily reports are documentation, not billable units.
3. **Pick the code automatically from the recorded duration.** If a patch is removed early, drop to the lower code; if <12 h on a Holter, add -52.
4. **Payer gating.** Cigna makes MCT second-line, after non-diagnostic ambulatory monitoring. Anthem (2023 text) requires ≥14 days of prior external monitoring for MCT. UHC MA, Noridian and Novitas use covered-diagnosis lists. Build an eligibility/diagnosis check per payer before generating the claim.
5. **Never put -26/-TC on these codes**; use the component codes.
