# 라우터를 SSD 라즈베리파이 5로 옮기기

지금 라우터는 SD 카드 위에서 돌고 있고(`/dev/mmcblk0`), 저장 쓰기가 주기적으로 멈추는 것이 유일하게 남은 구조적 문제다.
이 문서는 **SSD를 단 다른 라즈베리파이 5**로 옮기는 절차다. 머신러닝 기능을 넣은 뒤에 실행한다.

## 1. 왜 옮기는가 (측정값)

3.3시간 관측(`metrics_min`, 초당 7,805 레코드 수신 기준):

| 항목 | 값 |
|---|---|
| 저장 쓰기량 | 2.2 MB/s (14,700 write op / 4분 = 61 op/s) |
| 장치 사용률 | 20.8 % |
| 저장 큐가 2,000건 넘게 밀린 분 | 197분 중 33분 (17 %) |
| 큐 최고치 | p50 4,105 · p90 9,838 · 최대 31,766 |
| 환산 쓰기 정지 시간 | p50 0.5초 · 최대 4.1초 |

쓰기량 자체는 SD 카드 대역폭(수십 MB/s)의 10 % 수준이다. 문제는 대역폭이 아니라 **지연**이다.
카드 내부 정리(웨어 레벨링, 블록 소거)가 돌면 쓰기 한 번이 수백 ms에서 수 초까지 멈춘다.

그 결과:

- 저장 큐가 밀리고 라우터 메모리가 일시적으로 수십 MB 뛴다 (상한 262,144건, 약 26초분).
- 프레임 처리가 늦어져 **게이트웨이 무응답 알람이 한꺼번에 수백 건** 뜬다 (2026-09-20 18:53: 275건). 실제 장애가 아닌데 화면이 전부 붉어진다.
- 스톨이 풀릴 때 몰린 패킷이 뷰어 세션 큐를 넘겨 파형에 짧은 공백이 생긴다.

SSD(NVMe 또는 USB 3 SATA)는 쓰기 지연이 밀리초 단위로 일정해서 이 세 가지가 함께 사라진다.

### USB 메모리(USB 플래시 드라이브)는 대안이 아니다

USB 메모리는 SD 카드와 같은 저가 플래시에 컨트롤러만 다르다. 순차 읽기는 빠를 수 있어도
**작은 쓰기를 섞어 계속하는 이 워크로드에서는 SD 카드와 같거나 더 나쁘다**(DRAM 캐시 없음, 컨트롤러가 단순함).
우선순위는 다음과 같다.

1. **NVMe SSD + PCIe HAT** — 라즈베리파이 5의 PCIe 슬롯 사용. 가장 빠르고 지연이 일정하다.
2. **USB 3.0 + SATA SSD (UASP 지원 케이스)** — 충분히 좋다. 케이스가 UASP를 지원해야 한다.
3. USB 메모리 / SD 카드 — 지금 상태. 권장하지 않는다.

## 2. 옮기기 전 확인

- [ ] 머신러닝 기능 반영과 검증이 끝났다.
- [ ] 새 Pi에 SSD가 붙어 있고 `lsblk`에서 보인다 (`nvme0n1` 또는 `sda`).
- [ ] 새 Pi의 OS가 SSD에서 부팅되거나, 최소한 `/var/lib/biomonitor-router`가 SSD에 마운트된다.
- [ ] 새 Pi의 고정 IP를 정했다 (에뮬레이터가 이 주소로 접속한다).

## 3. 새 Pi 준비

```bash
# 1) 저장소 받기
git clone https://github.com/uxaipark/biomonitor_router.git ~/dev/biomonitor_router
cd ~/dev/biomonitor_router

# 2) 빌드 도구 (Rust는 rust-toolchain.toml 버전을 따라간다)
scripts/pi-dev-setup.sh          # rustup, build-essential, nodejs 확인
cargo --version && node --version

# 3) 라우터 빌드 (Pi 5에서 약 3~5분)
cd router-server && cargo build --release && cargo test --release && cd ..

# 4) 콘솔 빌드
cd web/console && npm ci && npm run build && cd ../..
```

SSD 마운트 (NVMe 예시):

```bash
sudo mkfs.ext4 -L router /dev/nvme0n1p1
sudo mkdir -p /var/lib/biomonitor-router
echo 'LABEL=router /var/lib/biomonitor-router ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount -a && df -h /var/lib/biomonitor-router
sudo chown -R $USER:$USER /var/lib/biomonitor-router
```

`noatime`은 읽기마다 메타데이터를 쓰지 않게 해서 쓰기량을 줄인다.

## 4. 옮길 데이터

| 대상 | 경로 (현재) | 옮길지 | 비고 |
|---|---|---|---|
| 그룹·운영 통계 DB | `data/router.db` (+`-wal`, `-shm`) | **예** | 뷰어 그룹 정의와 장기 통계가 들어 있다 |
| 디스플레이 설정 | `data/displays.json` | 예 | 작다 |
| 파형 저장소 | `data/store` (100 GB 이상) | 선택 | 과거 파형이 필요할 때만. `rsync -a --info=progress2` 로 몇 시간 걸린다 |
| 로그·감시 CSV | `data/*.log`, `data/leakwatch*.csv` | 선택 | 비교 분석용 |
| 채팅 브리지 | `data/chat/` | 예 | rp5-1과의 채널 |

라우터를 멈춘 뒤 복사한다(정상 종료가 저장 버퍼를 비운다).

```bash
# 옛 Pi에서
pkill -x router-server && sleep 5           # SIGTERM → 저장 플러시 후 종료
rsync -a data/router.db* data/displays.json data/chat/ NEWPI:/var/lib/biomonitor-router/
# 파형까지 옮긴다면
rsync -a --info=progress2 data/store/ NEWPI:/var/lib/biomonitor-router/store/
```

## 5. 새 Pi 설정

`deploy/pi/biomonitor-router.env`를 SSD 경로로 맞춘다.

```ini
ROUTER_INGEST_ADDR=0.0.0.0:9100
ROUTER_HTTP_ADDR=0.0.0.0:7300
ROUTER_EMULATOR_ADDR=192.168.0.125:5445
ROUTER_STORE_DIR=/var/lib/biomonitor-router/store
ROUTER_DB_PATH=/var/lib/biomonitor-router/router.db
ROUTER_DISPLAYS_PATH=/var/lib/biomonitor-router/displays.json
ROUTER_WEB_DIR=/home/master/dev/biomonitor_router/web/console/dist
ROUTER_STORE_MAX_GB=500          # SSD 용량에 맞춰. SD 때는 200
ROUTER_STORE_GZIP=0              # SSD에서는 1~3도 가능 (아래 참고)
MIMALLOC_PURGE_DELAY=0
RUST_LOG=info
```

**gzip 재검토**: SD에서는 시간당 압축 작업이 한 코어를 20 % 쓰고 쓰기량을 늘려서 껐다.
SSD에서는 켜도 되지만, CPU는 여전히 쓴다. 저장 용량이 넉넉하면 계속 0으로 두는 편이 안전하다.

systemd 설치:

```bash
sudo deploy/pi/install.sh        # 유닛·env·sysctl 설치 후 enable --now
systemctl status biomonitor-router
journalctl -u biomonitor-router -f
```

`install.sh`가 넣는 `99-biomonitor-router.conf`는 소켓 백로그와 파일 핸들 상한을 올린다
(게이트웨이 1,700개 + 파일 1,500개를 동시에 여는 구성이라 필요하다).

## 6. 에뮬레이터 전환

라우터가 뜬 뒤 에뮬레이터의 목적지를 새 Pi로 바꾼다.

```bash
curl -X PATCH http://192.168.0.125:5445/api/v1/config \
  -H 'content-type: application/json' \
  -d '{"transport": {"target_ip": "<새 Pi IP>", "target_port": 9100}}'
```

게이트웨이가 순차적으로 재접속한다. 1,700개가 붙는 데 1~2분 걸린다.

## 7. 검증 (옮긴 직후)

```bash
# 수신
curl -s localhost:7300/api/stats | python3 -m json.tool | head -20
#   ingest_connections ≈ 1,675, channels_connected ≈ 1,550, queue_dropped_wave = 0

# 저장 스톨이 사라졌는지 — 핵심 확인
python3 scripts/stallwatch.py 600
#   SD: 10분에 1~3회 스톨, 큐 최대 수천~3만
#   SSD 기대값: 스톨 0, 큐 최대 수백 이하

# 메모리·소켓 장기 추세
python3 scripts/leakwatch.py run --every 60 &        # 샘플러
python3 scripts/leakalert.py                         # 이상 감시

# 운영 통계 페이지
#   http://<새 Pi>:7300/#/test/ops  → 저장 스톨 사건이 더 이상 쌓이지 않아야 한다
```

기대 변화:

| 지표 | SD (현재) | SSD (기대) |
|---|---|---|
| 저장 스톨 | 시간당 1~3회, 최대 4.1초 | 0 |
| 게이트웨이 무응답 오탐 | 스톨마다 수백 건 | 0 |
| WS 지연 건너뜀 | 스톨 직후 5,000~15,000건 | 뷰어 쪽 원인만 남음 |
| 라우터 PSS | 110~160 MB (스톨 때 급등) | 110~130 MB 안정 |

## 8. 되돌리기

새 Pi에 문제가 있으면 에뮬레이터 목적지를 옛 Pi(192.168.0.209)로 되돌리고 옛 라우터를 다시 띄운다.
저장소는 각자 Pi에 있으므로 섞이지 않는다.

```bash
curl -X PATCH http://192.168.0.125:5445/api/v1/config -H 'content-type: application/json' \
  -d '{"transport": {"target_ip": "192.168.0.209", "target_port": 9100}}'
# 옛 Pi에서
cd ~/dev/biomonitor_router && scripts/run-router-pi.sh
```

## 9. 옮긴 뒤 다시 볼 것

- `ROUTER_STORE_MAX_GB`를 SSD 용량의 70 % 정도로 잡는다. 상한에 닿으면 오래된 시간 파일부터 지운다.
- 스톨이 사라지면 저장 큐 상한(262,144)과 200 ms 백프레셔를 줄여도 되는지 재검토한다.
- 알람 오탐 방지책(무응답 판정을 수신 시각 기준으로 분리, 대량 무응답을 한 건으로 묶기)은
  SSD에서도 네트워크 장애 때 쓸모가 있으므로 그대로 둔다.
- 여유가 생긴 CPU로 머신러닝 추론을 라우터 안에서 돌릴지, 분석 서버로 분리할지 정한다.
