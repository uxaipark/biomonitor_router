# Field Inventory / VMI Practice for Disposable Wearable ECG Patches

Research note for checking the design of a rep/reseller field-inventory tool. Researched 2026-10-01.
Legend: **[V]** backed by a cited source. **[I]** industry practice I am confident of but could not pin to a public source here. **[U]** unverified or an assumption; check with customers.

---

## 1. Inventory models

| Model | Who owns stock at the hospital | Who triggers replenishment | How billing works | Typical use |
|---|---|---|---|---|
| **Hospital-owned purchase (traditional)** | Hospital, from receipt | Hospital buyer (ERP requisition, PO) | Hospital PO, then invoice on shipment, net 30-60 [I] | Commodity med-surg |
| **Par-level replenishment (PAR)** | Usually the hospital | Whoever counts against the par: hospital supply tech, distributor, or vendor rep | PO per replenishment, or a blanket PO with releases [I] | Nursing units, supply rooms [V: RF-SMART, Capsa] |
| **Kanban / two-bin** | Hospital | An empty bin (card or label scanned) triggers a refill of a fixed quantity | Same as PAR | Supply rooms. Syft and GHX sell kanban modules [V] |
| **Vendor-managed inventory (VMI)** | Usually the hospital, with title passing at shipment or receipt. Some VMI keeps supplier ownership [V: Orderful, aislestock] | The **supplier** decides when and how much, based on on-hand and usage data the customer shares (EDI 852 in retail; counts or portal data in hospitals) [V] | PO and invoice per shipment, often against a blanket or standing PO [I] | Pharma, high-volume disposables [V: Krichanchai & MacCarthy] |
| **Consignment (bill-on-use)** | **Supplier**, until use. Title transfers when the item is used or consumed [V: Ventory] | Supplier or rep, based on usage reports and counts | The hospital issues a PO **after use** for the used items only, then the supplier invoices. Variants are called "bill-only" and "bill-and-replace" [V: GHX] | Implants, cath-lab and EP devices, high-cost disposables |

How the big players run it:
- **Medtronic, Boston Scientific, J&J (implants, CRM, EP):** These companies keep consigned shelves in the cath lab or OR. After each case the rep (or hospital staff) records what was used, usually on a sticker sheet or an implant log. The hospital then raises a "bill-only" PO and the manufacturer invoices. Bill-and-replace means the hospital also receives a replacement unit, and the hospital must receive that unit before the invoice can be matched [V: GHX, ReadySet, Casechek, Mediclick]. GHX automates this flow. For example, HCA's vendor bill-only project reached more than 93% accuracy and cut surgery-to-invoice time by more than 6 days [V: GHX].
- **Hospital-side point-of-use systems** let the hospital see owned and consigned stock side by side. Examples: Owens & Minor QSight (RFID cabinets in the cath lab, consigned inventory visibility, claimed 99.9% count accuracy), Cardinal WaveMark (Smart Par recommendations), Tecsys Elite POU (bill-only reconciliation, automatic PO creation), PAR Excellence (weight scales, bill-only, recall management) [V].
- **iRhythm Zio:** This is a service model. The clinic holds monitors in stock, the patient mails the device back after wear, and iRhythm bills for the monitoring service. The ZioSuite portal lets clinic admins "see and manage shipments that are on the way" and inventory "in stock", and track each monitor's location, including unreturned monitors [V: ZioSuite page]. Their exact replenishment terms (consigned vs bought, auto-ship) are **not public** [U].
- **Medline, Cardinal, Owens & Minor (distributors):** They run PAR and VMI programs for med-surg supplies. Examples are Cardinal Inventory Manager (JIT replenishment from automated order points) and Pyxis ParAssist handhelds [V: Cardinal newsroom]. Medline SPS details were not retrieved [U].

**What this means for a patch supplier:** A disposable ECG patch is a fairly predictable, mid-value consumable. The models that fit best are **VMI with par levels** (the hospital buys, the rep keeps it stocked) or **consignment** (the hospital pays per patch used, the supplier carries the stock). Your tool should support both at contract level, because the billing trigger is the only real difference.

---

## 2. Step-by-step field procedure

### 2.1 Contract setup (once per hospital, reviewed yearly)
Put these in the contract record [V: Cleverence/consignment guides list par levels, usage reporting timelines, ownership transfer trigger, expiry return policy and shrinkage liability as required consignment terms]:
- The **model** (purchase/VMI vs consignment) and the **ownership transfer point** (shipment, receipt, or use).
- **SKUs, contract price** and price escalators. If a reseller sits in between, record the price tiers: supplier to reseller, and reseller to hospital [I].
- **Committed volume** (annual or monthly minimum, take-or-pay or rebate tiers) [I].
- **Par per stocking location.** Usually there are several locations per hospital (cardiology clinic, ED, wards).
- **Delivery SLA** (for example, standard 2-3 business days, emergency next day) [U: typical figures].
- **Count/visit cadence** and who counts.
- **Usage reporting deadline** for consignment (for example, usage reported within X days, or monthly) [V: listed as a contract term; the value is U].
- **Expiry policy:** the minimum remaining shelf life at delivery, and whether near-expiry stock can be swapped or returned.
- **Shrinkage liability:** in consignment the hospital is normally liable for unexplained losses [V: Rosales et al. 2023, JOM].
- **Audit right and frequency**, plus who signs off.
- **PO mechanics:** a PO per order, or a blanket PO with a ceiling and expiry date.

### 2.2 Visit or remote replenishment cycle
1. **Plan the visit.** The tool proposes which hospitals need a visit, based on days of supply, upcoming expiries and open issues [I].
2. **Cycle count at each location.** Scan every box or carton. A GS1 DataMatrix/UDI gives GTIN (AI 01), lot (AI 10), expiry (AI 17) and serial (AI 21, if used) [V: GS1, FDA UDI]. Offer manual entry as a fallback, because some labels do not carry everything [V: GS1/Dynamsoft notes that lot or expiry sometimes has to be keyed]. Use smaller recurring cycle counts, not annual counts [V: ConnectSX]. Frequency: at every visit, or weekly to monthly for consignment [U: no public standard found; choose per contract].
3. **Compare with the book.** Book quantity = last count + deliveries received − recorded usage − returns. The difference is either unrecorded usage or shrinkage. Classify it with a reason: used-not-recorded, damaged, expired, lost, or found.
4. **Calculate the replenishment quantity:** order-up-to (par) minus on-hand minus in-transit (see section 5).
5. **Create the order.** In the VMI/purchase model the hospital must supply or approve a **PO number** before shipping, or the order references the blanket PO. Approval workflow: rep drafts, then the hospital buyer approves or adds the PO in the portal or by email [I]. In consignment, replenishment can ship without a PO. The PO is raised later for used items (bill-only) [V: GHX, Casechek].
6. **Ship** from the supplier warehouse or the reseller stock. Record lot/serial per shipment line. This is needed for recall consignee lists [V: 21 CFR 806.10(c) requires consignee name, address, dates and quantities].
7. **Delivery and receiving.** Hospitals usually receive at a **central receiving dock**. Materials management then moves goods to the department, which can take a day or two. Some contracts allow the rep to deliver direct to the department [I]. Capture **proof of delivery** (who received, when, signature or photo) and a **receipt confirmation** per location. In bill-and-replace, receipt must be recorded before the invoice matches [V: Mediclick].
8. **Put-away with FEFO** (first-expired-first-out). Put new stock behind older stock. Two-bin layouts naturally rotate FIFO [V: Capsa/Southwest].
9. **Usage capture.** Options run from best to worst. (a) Scan at point of use, or pull from the EMR/charge capture (each patch applied to a patient is a billable event for the monitoring service, so the study/order record is a strong usage signal). (b) Staff log use in the customer portal. (c) Infer usage from counts (last count + received − current count). Barcode capture at point of care beats manual entry for accuracy and revenue capture [V: AHRMM UDI POC report].
10. **Invoicing.** VMI/purchase: invoice per shipment against the PO. Consignment: produce a periodic **usage statement** (for example, monthly), the hospital issues a bill-only PO, then you invoice. Differences between usage and counts turn into a shrinkage invoice under contract terms [V: hospital liable; mechanics I].
11. **Expiry rotation.** Flag lots that will expire within N days (for example 90/60/30) [U: thresholds not published; Movemedical only describes "alerts before expiry"]. Actions: use first, **transfer to a higher-usage site** (a stock transfer between hospitals owned by the same entity, or a return-and-reship), or return for credit. Expiry write-off in consignment is the supplier's cost. W.L. Gore cut expired consignment by 82% with real-time tracking [V: Movemedical].
12. **Returns/RMA.** The rep requests an RMA (reason: near expiry, overstock, wrong item, damaged). The return label and lot are recorded. On receipt, a credit is issued or the quantity is adjusted [I].
13. **Damaged goods.** Record at receipt (carrier claim) or on site (photo, reason). Remove from on-hand. Decide whether to replace free of charge [I].
14. **Recall.** Query by lot to find every hospital and location holding it, plus every patient use if known. Notify those accounts ("direct accounts"), quarantine the stock, count what remains, return it, and record proof of effectiveness [V: FDA Ch.7 / 21 CFR 806; FDA allows targeting only the customers who received the affected lots when distribution records are accurate].
15. **Reconciliation and audit sign-off.** Run a periodic (quarterly or annual) full physical count of consigned stock, with lot and expiry verification. Publish a variance report. A hospital representative signs off and agrees liability for the variance [V: consignment audit practice in Cleverence/Finale; cadence U]. Shrinkage of 5-15% is quoted where real-time consumption data is missing [V: Cleverence, a vendor blog, so treat as indicative].

---

## 3. KPIs

| KPI | Formula (practical) | Note |
|---|---|---|
| **Days of supply (DoS)** | on-hand ÷ average daily usage | The main per-location health signal [V: weeks of supply = on-hand ÷ average weekly usage] |
| **Fill rate** | units (or lines, or orders) shipped complete on time ÷ requested | Line, order and unit variants exist [V: SkuNexus] |
| **Stockout events** | count of location-days with on-hand = 0, or patient studies delayed | Also track **emergency shipments** [V: ConnectSX] |
| **Inventory turns** | annual usage ÷ average on-hand | Higher turns mean less expiry risk |
| **Expiry write-off rate** | expired units (or value) ÷ units supplied | Critical for dated disposables [V] |
| **Consignment value on hand** | Σ on-hand × cost, at supplier-owned locations | This is working capital the supplier carries |
| **Count accuracy** | 1 − abs(book − physical) ÷ book, or % of locations with zero variance | [V: listed as a KPI] |
| **Shrink rate** | unexplained loss ÷ usage | [V] |
| **Forecast accuracy** | 1 − MAPE of forecast vs actual usage per period | [I] |
| **Usage-to-invoice lag** | days from use to invoice | HCA cut theirs by 6+ days [V: GHX] |
| **Invoice dispute rate** | disputed invoices ÷ invoices | [V: Cleverence] |
| **Contract compliance** | actual volume ÷ committed volume | [I] |

---

## 4. Typical software features and UX

Representative tools: Movemedical, mymediset, DeviceFlow, Terso RFID, ConnectSX, ImplantBase (supplier-side field inventory), and QSight, Tecsys, PAR Excellence, Syft, WaveMark, GHX (hospital-side).

Common features [V unless marked]:
- **Mobile scanning** with the camera or a Bluetooth scanner, decoding GS1 and HIBCC with auto-filled lot and expiry. Movemedical claims cycle counts go "from hours to minutes".
- **Real-time visibility** across consignment, trunk and loaner stock, by location.
- **PAR management** and recommended par changes from usage history (WaveMark Smart Par, RF-SMART).
- **Usage capture** with barcode plus signature.
- **Expiry and recall alerts** (Movemedical, PAR Excellence recall management).
- **Bill-only/consignment PO automation** and invoice reconciliation (GHX, Tecsys).
- **ERP/CRM integration** to avoid double entry.
- **Audit trail** (who used or moved what, and when) (Terso).
- **Customer portal**: hospital staff see stock in hand and inbound shipments (ZioSuite), approve orders, enter PO numbers.
- **Reports**: usage by site, variance, expiry, KPI dashboards (QSight 2.0 reporting).
- **Rep visit checklists** and route planning [I; common in field-service tools, not confirmed for each vendor].

UX patterns that make these tools usable [I, consistent with vendor descriptions]:
- **Scan-first flows.** Each scan increments a count line grouped by lot. Duplicate serials are rejected. Use a big confirm button and keep typing to a minimum.
- **Offline mode.** Hospital basements and storerooms often have no signal. Queue scans and sync later.
- **A "suggested order" screen** that is pre-filled from par − on-hand − in-transit. The rep only adjusts and submits. Show the reason for each number (DoS, expiries).
- **Exception-driven home screen.** "3 hospitals below min, 2 lots expiring in 60 days, 1 PO awaiting approval", rather than raw tables.
- **Traffic-light DoS** per hospital and location.
- **One-tap variance reasons** (used, damaged, expired, lost, found).
- **Signature or photo capture** for proof of delivery and audit sign-off, then a PDF emailed to the hospital.
- **Hospital portal kept minimal:** see stock, approve or attach a PO, confirm receipt, report usage or problems. Hospital staff will not learn a complex app.

---

## 5. Replenishment formulas used in practice

Notation: d = average daily usage, σd = standard deviation of daily usage, L = lead time in days (order to on-shelf, **including hospital dock-to-department time**), R = review period in days (time between visits or counts), z = service factor (1.65 ≈ 95%, 2.05 ≈ 98%).

- **Reorder point (continuous review):** ROP = d·L + SS [V: Wikipedia, ABC Supply Chain].
- **Safety stock (simple):** SS = z·σd·√L. Max-min heuristic: SS = (max daily × max lead) − (avg daily × avg lead) [V: ShipBob/ABC].
- **Periodic review (the usual case for rep visits) = order-up-to / (R,S):** S = d·(R+L) + z·σd·√(R+L). Order qty = S − on-hand − on-order [V: Salesia example, 12-day lead + 7-day review means cover for 19 days].
- **(s,S) / min-max:** order up to max (S) only when inventory position ≤ min (s). This avoids tiny orders. Min ≈ ROP, max ≈ S.
- **Par = S** in hospital language: "enough to support patient care from when the closet is stocked until the next time it is counted", plus a buffer [V: RF-SMART].
- **Days-of-supply targets** are how reps actually think: for example min = 14 days, max = 30 days of usage [U: illustrative].
- **Shelf-life cap:** max ≤ d × (remaining shelf life − safety margin), so stock does not expire on the shelf. This matters for dated adhesive electrodes [I].
- **Pack rounding:** round the order up to box or case multiples [I].

Parameters reps or account managers **actually edit** [I]: par/max and min per location (or DoS targets), review/visit frequency, lead time override for a site, pack size and rounding, a temporary uplift (new cardiologist, seasonal campaign, ward opening), and freezing a location. They do **not** edit z or σ directly. The system should *suggest* par changes from history (as WaveMark and RF-SMART do) and let the rep accept or reject them.

For a 14-day-wear patch: one patch per patient study (plus spares for re-application failures [U]). That makes usage ≈ number of studies, which is a good forecast driver if the monitoring-service data is available.

---

## 6. Must-have vs nice-to-have (minimal but correct tool)

### Must-have
1. **Master data:** hospital → stocking locations; SKUs with GTIN, pack size and shelf life; contracts (model: purchase/VMI vs consignment, price, committed volume, par or DoS per location, SLA, expiry policy, PO mode); rep and reseller assignment, with many hospitals per rep.
2. **Lot/expiry-level stock ledger** per location. Every movement is a transaction (receive, use, transfer, return, adjust, write-off) with user, timestamp and reason. On-hand is derived from the ledger, never edited directly.
3. **Mobile cycle count** with GS1 DataMatrix scanning (AI 01/10/17/21), manual fallback, offline queue, and a variance screen with reason codes.
4. **Suggested replenishment** = par − on-hand − in-transit, with pack rounding and FEFO awareness. The rep edits, then submits.
5. **Order workflow with status:** draft → awaiting hospital PO/approval → approved → shipped (lot captured) → delivered (POD) → received at location. Blanket PO support (ceiling, remaining balance, expiry).
6. **Usage capture**, at minimum derived from counts plus manual entry. For consignment, a **monthly usage statement** that drives the bill-only PO and invoice.
7. **Expiry alerts** (configurable windows) and a **transfer** action between locations or hospitals.
8. **Returns/RMA and damaged/write-off** transactions.
9. **Recall lookup by lot** → list of hospitals, locations and quantities, plus a quarantine action. Distribution records good enough for 21 CFR 806 consignee lists.
10. **Periodic reconciliation report** (book vs physical, by lot) with hospital sign-off (name, signature, date) exported as PDF.
11. **Dashboard per rep:** DoS traffic light per hospital, below-min list, expiring lots, pending POs, overdue visits.
12. **Roles/permissions:** supplier admin, reseller, rep, and hospital user (read stock, approve/enter PO, confirm receipt). Full audit trail.

### Nice-to-have
- Hospital self-service portal for logging usage and reporting problems; email/SMS alerts.
- Usage from the monitoring-service or EMR integration (studies started per site) instead of count-derived usage.
- Par recommendations from history (accept/reject), forecast accuracy tracking.
- Visit planning and route optimization; visit checklists.
- ERP/accounting integration (orders, invoices); EDI or GHX connectivity for hospital POs and invoices.
- Contract compliance tracking (volume vs commitment, rebate tiers).
- Reseller stock (trunk or reseller warehouse) as its own location type.
- RFID or smart cabinets (overkill for a low-cost patch).
- KPI reporting: turns, fill rate, expiry write-off %, consignment value on hand, count accuracy.

### Design pitfalls to check
- Lead time must include dock-to-department transit. Otherwise par is too low.
- Do not let on-hand be typed over. Adjustments must be transactions with reasons, or the audit sign-off is meaningless.
- Track "in transit" separately, so reps do not double-order between shipping and receipt.
- Shelf-life cap on max/par, so the tool does not over-stock dated product.
- Shrinkage liability and the usage-report deadline are contract fields, not hard-coded rules.

---

## Sources
- GHX, bill-only/consignment: https://www.ghx.com/the-healthcare-hub/automate-bill-only-implant-orders/ ; https://www.ghx.com/the-healthcare-hub/bill-only-healthcare-product-delivery/ ; https://www.ghx.com/media/2yemf25j/ghx_bill-only-implant-consignment-brochure.pdf
- Casechek bill-only: https://www.casechek.com/what-is-bill-only/ ; ReadySet: https://readysetsurgical.com/resources/what-is-bill-only/
- Mediclick bill-only req/PO: https://proclick.mediclick.com/ematerials/help/procedures/BillOnlyReqsPOs.htm
- Ventory, medical consignment: https://www.ventory.io/blog-posts/medical-consignment-inventory-sales-enhancer-or-operational-blind-spot
- Rosales et al. 2023, consignment shrinkage (JOM): https://onlinelibrary.wiley.com/doi/full/10.1002/joom.1256
- Cleverence consignment KPIs/audits: https://www.cleverence.com/articles/for-business/consignment-inventory-management-5827/
- Owens & Minor QSight: https://www.owens-minor.com/services/qsight/ ; https://www.owens-minor.com/services/qsight/qsight-rfid/
- Cardinal Health (Inventory Manager, WaveMark, ParAssist): https://newsroom.cardinalhealth.com/company-news?item=122402 ; https://www.cardinalhealth.com/en/solutions/wavemark-supply-management/resource-center/best-practices/invest-in-your-clinical-supply-chain.html
- Tecsys Elite POU: https://www.tecsys.com/elite-healthcare-solutions/point-of-use
- PAR Excellence: https://parexcellence.com/ ; Syft: https://www.supplychainmarket.com/doc/syft-launches-version-syft-synergy-platform-0001
- iRhythm ZioSuite: https://www.irhythmtech.com/us/en/solutions-services/irhythm-service/ziosuite
- Movemedical: https://movemedical.com/post/medical-device-inventory-optimization-system ; https://movemedical.com/post/expired-consignment-inventory-doesnt-disappear-heres-what-it-actually-costs----and-how-leading-medtechs-stopped-it
- Terso field inventory: https://www.tersosolutions.com/field-inventory-management-rfid-inventory-management-for-medical-devices
- ConnectSX guide: https://connectsx.com/blog/medical-device-inventory-management-guide
- RF-SMART PAR: https://www.rfsmart.com/blog/par-inventory-management-best-practices ; Capsa PAR: https://www.capsahealthcare.com/blog/hospital-supply-chain/healthcare-par-inventory-management-best-practices/
- VMI: https://www.orderful.com/blog/what-is-vendor-managed-inventory ; Krichanchai & MacCarthy (hospital VMI): https://nottingham-repository.worktribe.com/file/971290/1/Krichanchai%20%20MacCarthy%20IJLM%202016%20REPOSITORY.pdf
- GS1 2D/UDI: https://www.gs1.org/industries/healthcare/2d-barcode-healthcare ; AHRMM UDI at POC: https://www.ahrmm.org/system/files/media/file/2019/11/Barcode-at-POC-work-group-report-102019.pdf
- FDA recalls / 21 CFR 806: https://www.fda.gov/medical-devices/postmarket-requirements-devices/recalls-corrections-and-removals-devices ; https://www.fda.gov/media/71814/download
- KPIs: https://www.skunexus.com/blog/inventory-management-kpis
- Reorder point / safety stock: https://en.wikipedia.org/wiki/Reorder_point ; https://abcsupplychain.com/reorder-point-formula/ ; https://salesia.fr/en/blog/safety-stock-reorder-point
