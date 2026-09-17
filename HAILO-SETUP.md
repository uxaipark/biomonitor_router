# Hailo-8L on Raspberry Pi 5 — 셋업 및 벤치마크 기록

측정일: 2026-09-05

## 하드웨어 / 소프트웨어

| 항목 | 값 |
|---|---|
| 모듈 | HAILO-8L AI ACC M.2 B+M KEY MODULE EXT TMP |
| 아키텍처 | HAILO8L (보드명은 `Hailo-8`으로 보고됨) |
| 피크 성능 | 13 TOPS (INT8, 사양) |
| S/N · P/N | HLDDLBB243301310 · HM21LB1C2LAE |
| PCIe 주소 · ID | `0001:01:00.0` · `1e60:2864` |
| 호스트 | Raspberry Pi 5 (BCM2712), Debian 12 bookworm |
| 커널 | 6.12.96+rpt-rpi-2712 |
| 스택 | hailo-all 4.20.0, hailort 4.20.0, tappas-core 3.31.0, hailofw 4.20.0 |
| 펌웨어 | 4.20.0 (release, app, extended context switch buffer) |

## 변경 사항: PCIe Gen2 → Gen3

`/boot/firmware/config.txt` 의 `[all]` 섹션에 추가:

```
dtparam=pciex1_gen=3
```

| | LnkSta |
|---|---|
| 변경 전 | `Speed 5GT/s (downgraded), Width x1 (downgraded)` |
| 변경 후 | `Speed 8GT/s, Width x1 (downgraded)` |

`Width x1` 은 Pi 5가 물리적으로 1레인만 배선하기 때문이며 변경 불가.
Gen3는 라즈베리파이가 공식 인증한 속도가 아니다(보드 검증은 Gen2까지).

백업: `/boot/firmware/config.txt.bak-pcie-gen2`

## 벤치마크 결과

조건: `hailortcli run -t 8 --batch-size 16 --power-mode ultra_performance`

| 모델 | 컨텍스트 | Gen2 FPS | Gen3 FPS | 변화 | GOPS/frame | Gen2 TOPS | Gen3 TOPS |
|---|---|---|---|---|---|---|---|
| yolov8s (640) | 3 | 75.9 | 149.8 | +97% | 28.65 | 2.17 | 4.29 |
| resnet_v1_50 (224) | 3 | 239.8 | 400.8 | +67% | 6.98 | 1.67 | 2.80 |
| yolox_s_leaky (640) | 4 | 75.9 | 121.9 | +61% | 26.74 | 2.03 | 3.26 |
| yolov6n (640) | 1 | 311.4 | 355.1 | +14% | 11.12 | 3.46 | 3.95 |

TOPS는 실측 FPS × 공개 모델 연산량(Hailo Model Zoo 표기, 1 MAC = 2 OPS)으로 환산한
**실효값**이다. 칩이 TOPS를 직접 보고하지는 않는다. 피크 13 TOPS 대비 가동률 22~33%.

### 지연시간

| 모델 | HW Latency Gen2 → Gen3 | Overall Gen2 → Gen3 |
|---|---|---|
| yolov8s | 26.20 → 13.11 ms | 33.42 → 17.20 ms |
| resnet_v1_50 | 39.65 → 15.44 ms | — → 21.08 ms |

Python API 단발 추론(YOLOv8s, warm-up 후 20회 평균): 28.5 → 17.2 ms.

### PCIe 대역폭 실측 (Mbit/s)

| 모델 | Gen2 Send | Gen2 Recv | Gen3 Send | Gen3 Recv |
|---|---|---|---|---|
| yolov6n | 2986.5 | 1751.9 | 3490.6 | 2047.6 |
| yolov8s | 675.9 | 671.6 | 1472.5 | 1463.3 |
| resnet_v1_50 | 184.0 | 1.2 | 482.4 | 3.2 |

## 분석: 이득의 원인은 대역폭이 아니다

Gen2 x1의 이론 한계는 방향당 약 4000 Mbit/s다. 그런데:

- **ResNet50**은 Gen3에서도 482 Mbit/s(한계의 12%)만 쓰는데 67% 빨라졌다.
  대역폭에 막혀 있던 것이 아니다.
- **YOLOv6n**은 Gen2에서 2986 Mbit/s로 한계의 75%까지 차 있었는데, 가장 적게(14%) 올랐다.

대역폭 가설과 정반대의 패턴이다. 실제 상관관계는 **컨텍스트 수**다.
멀티 컨텍스트 모델(3~4개)은 61~97% 오른 반면, 싱글 컨텍스트인 yolov6n만 14%에 그쳤다.
멀티 컨텍스트는 추론 도중 컨텍스트마다 가중치·설정을 PCIe로 다시 밀어넣어야 하므로,
대역폭 총량보다 **전송 지연**에 민감하다.

### 남은 교란 요인

같은 재부팅에서 커널이 6.12.34 → 6.12.96으로 올라갔고 드라이버도 재빌드됐다.
따라서 이 측정만으로 Gen3 단독 효과와 커널·드라이버 업데이트 효과가 분리되지 않는다.
위 컨텍스트 상관관계는 Gen3 쪽 설명에 무게를 싣지만 증명은 아니다.
깔끔히 가르려면 현재 커널 그대로 Gen2로 되돌려 같은 스크립트를 재실행하면 된다.

## 검증

**정확도** — YOLOv8s로 bus.jpg 추론 시 Gen2/Gen3 결과가 비트 단위로 동일:

```
bus     0.913  (23,229)-(797,740)
person  0.910  (51,398)-(244,905)
person  0.876  (223,406)-(347,862)
person  0.876  (667,393)-(809,877)
person  0.623  (0,551)-(76,867)
```

**PCIe 오류** — 전 항목 클린. dmesg에 AER/링크 오류 없음.

```
DevSta: CorrErr- NonFatalErr- FatalErr- UnsupReq-
UESta:  DLP- SDES- TLP- FCP- CmpltTO- CmpltAbrt- UnxCmplt- RxOF- MalfTLP- ECRC- UnsupReq- ACSViol-
```

## 함정: 커널 업데이트 시 DKMS가 Pi 5 플레이버를 빠뜨린다

이번 재부팅에서 `/dev/hailo0` 이 사라졌던 원인. DKMS가 새 커널의 `v8` 플레이버용으로만
빌드하고, Pi 5가 실제로 부팅하는 `2712` 플레이버는 빌드하지 않는다.

```
hailo_pci/4.20.0, 6.12.96+rpt-rpi-2712 : installed   ← 수동 추가분
hailo_pci/4.20.0, 6.12.96+rpt-rpi-v8   : installed   ← DKMS 자동 생성분
```

**증상**: `lspci` 에는 Hailo가 보이는데 `/dev/hailo0` 이 없고
`modprobe: FATAL: Module hailo_pci not found`.

**복구** (재설치 불필요):

```bash
sudo dkms install hailo_pci/4.20.0 -k $(uname -r) && sudo modprobe hailo_pci
```

커널 업데이트 후 Hailo가 안 잡히면 항상 여기부터 확인할 것.

### 자동 로드는 정상

모듈만 있으면 udev가 PCI ID 매칭으로 부팅 시 자동 로드한다. 실측 확인:

```
modules.alias : pci:v00001E60d00002864...  → hailo_pci
장치 modalias : pci:v00001E60d00002864...     (일치)
```

`modprobe -r` 후 `udevadm trigger` 로 자동 재로드 및 `/dev/hailo0` 재생성 확인함.

## 운영 노트

- **`--power-mode ultra_performance` 는 기본값이 아니다.** 기본 `performance` 대비
  Gen2 기준 ResNet50이 152 → 240 FPS(+58%). 실사용 코드에서 명시적으로 켤 것.
- `--measure-power` 는 이 M.2 모듈에서 미지원. `--measure-temp` 는 동작
  (부하 시 41.9~43.6°C).
- 카메라는 미연결 상태(`rpicam-hello` → `No cameras available!`).
- 모델 파일 위치: `/usr/share/hailo-models/*.hef`. 디바이스가 8L이므로 `_h8l` 접미사
  모델을 쓸 것(`_h8` 은 Hailo-8 전용).

## 되돌리기

```bash
sudo cp /boot/firmware/config.txt.bak-pcie-gen2 /boot/firmware/config.txt
sudo reboot
```

부팅이 막히면 SD/SSD를 다른 PC에 꽂아 부트 파티션에서 동일 작업.

## 파일

| 경로 | 내용 |
|---|---|
| `/home/master/dev/hailo_bench.sh` | Gen2 기준선 내장 비교 벤치마크 |
| `/home/master/dev/HAILO-SETUP.md` | 이 문서 |
| `/boot/firmware/config.txt.bak-pcie-gen2` | Gen2 시절 config 백업 |
