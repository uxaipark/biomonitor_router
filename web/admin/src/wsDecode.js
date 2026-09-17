// 바이너리 stream_batch 프레임 디코더.
// 포맷(LE): [u8 0xB1][u32 header_len][header JSON][i16 샘플 블롭]
//   header = {"type":"stream_batch","counts":[n,...],"items":[<stream 메타>...]}
// items[i].samples 는 비어 있고, 블롭에서 counts[i] 개씩 잘라 ÷1000 (µV → mV) 복원.
const td = new TextDecoder()

export function decodeStreamBatch(buf) {
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== 0xb1) return []
  const hlen = dv.getUint32(1, true)
  const header = JSON.parse(td.decode(new Uint8Array(buf, 5, hlen)))
  const items = header.items || []
  const counts = header.counts || []
  let off = 5 + hlen
  for (let i = 0; i < items.length; i++) {
    const n = counts[i] || 0
    // DataView 로 직접 읽어 중간 Int16Array 복사(slice) 할당 제거
    const f = new Float32Array(n)
    for (let k = 0; k < n; k++) f[k] = dv.getInt16(off + k * 2, true) / 1000
    off += n * 2
    items[i].samples = f
  }
  return items
}
