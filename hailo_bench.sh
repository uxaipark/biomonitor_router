#!/bin/bash
# Hailo-8L 벤치마크 — PCIe Gen2 vs Gen3 비교용
MODELS="resnet_v1_50_h8l yolov6n_h8l yolov8s_h8l yolox_s_leaky_h8l_rpi"
declare -A GOPS=( [resnet_v1_50_h8l]=6.98 [yolov6n_h8l]=11.12 [yolov8s_h8l]=28.65 [yolox_s_leaky_h8l_rpi]=26.74 )
# Gen2 기준선 (ultra_performance, batch 16)
declare -A BASE=( [resnet_v1_50_h8l]=239.81 [yolov6n_h8l]=311.36 [yolov8s_h8l]=75.91 [yolox_s_leaky_h8l_rpi]=75.92 )

echo "=== PCIe 링크 상태 ==="
sudo lspci -vv -s 0001:01:00.0 2>/dev/null | grep -E "LnkCap:|LnkSta:" | sed 's/^\s*/  /'
echo
printf "%-24s %10s %10s %8s %10s\n" "모델" "Gen2 FPS" "현재 FPS" "변화" "실효TOPS"
printf -- "----------------------------------------------------------------\n"
for m in $MODELS; do
  fps=$(timeout 200 hailortcli run /usr/share/hailo-models/$m.hef -t 8 --batch-size 16 \
        --power-mode ultra_performance --dont-show-progress 2>&1 | grep -oP 'FPS: \K[0-9.]+')
  [ -z "$fps" ] && fps=0
  b=${BASE[$m]}; g=${GOPS[$m]}
  awk -v m="$m" -v f="$fps" -v b="$b" -v g="$g" \
    'BEGIN{printf "%-24s %10.1f %10.1f %7.1f%% %9.2f\n", m, b, f, (f-b)/b*100, g*f/1000}'
done
printf -- "----------------------------------------------------------------\n"
echo
echo "=== 지연시간 (batch 1) ==="
for m in yolov8s_h8l resnet_v1_50_h8l; do
  printf "  %-22s " $m
  timeout 200 hailortcli run /usr/share/hailo-models/$m.hef -t 6 --measure-latency \
    --measure-overall-latency --dont-show-progress 2>&1 | grep -E "HW Latency|Overall" | tr -d '\n'
  echo
done
