import React, { useState } from 'react'

const ATTRS = [
  ['building', '건물'], ['floor', '층'], ['ward', '병동'], ['zone', '구역'],
  ['room', '병실'], ['doctor', '주치의'], ['department', '진료과목'], ['nurse', '간호사'],
]

const csv = (arr) => (arr || []).join(', ')
const parseCsv = (s) =>
  s.split(',').map((v) => v.trim()).filter((v) => v.length > 0)

// 그룹 생성/수정 폼.
// criteria: 속성별 허용 값(쉼표 구분, OR), 여러 속성은 AND.
// include/exclude: 채널 ID 수동 지정 (exclude 최우선).
// 상단에는 현재 채널들이 실제로 갖는 값을 속성별 체크박스로 펼쳐 보여주고,
// 하단 입력창과 양방향 동기화된다 (체크 → 입력창 반영, 직접 입력도 가능).
export default function GroupEditor({ group, isNew, channels = [], onSave, onDelete, onCancel }) {
  const [id, setId] = useState(group?.id || '')
  const [name, setName] = useState(group?.name || '')
  const [description, setDescription] = useState(group?.description || '')
  const [owner, setOwner] = useState(group?.owner || '')
  const [criteria, setCriteria] = useState(() => {
    const init = {}
    for (const [key] of ATTRS) init[key] = csv(group?.criteria?.[key])
    return init
  })
  const [include, setInclude] = useState(csv(group?.include))
  const [exclude, setExclude] = useState(csv(group?.exclude))

  // 속성별로 현재 채널들이 갖는 고유 값 (그루핑 가능한 모든 값)
  const distinct = (key) => {
    const set = new Set()
    for (const c of channels) {
      const v = c.patient?.[key]
      if (v) set.add(String(v))
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'))
  }

  const isChecked = (key, v) => parseCsv(criteria[key]).includes(v)

  const toggleVal = (key, v) => {
    const vals = parseCsv(criteria[key])
    const next = vals.includes(v) ? vals.filter((x) => x !== v) : [...vals, v]
    setCriteria({ ...criteria, [key]: next.join(', ') })
  }

  const submit = (e) => {
    e.preventDefault()
    const outCriteria = {}
    for (const [key] of ATTRS) {
      const vals = parseCsv(criteria[key])
      if (vals.length) outCriteria[key] = vals
    }
    onSave({
      id: id.trim(),
      name: name.trim() || id.trim(),
      description: description.trim(),
      owner: owner.trim().slice(0, 10),
      criteria: outCriteria,
      include: parseCsv(include),
      exclude: parseCsv(exclude),
    })
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="row">
        <label>그룹 ID</label>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={!isNew}
          placeholder="예: ward-w1"
          required
        />
        <label>이름</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 병동 W1" />
      </div>
      <div className="row">
        <label>설명(메모)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="이 그룹의 용도/대상 메모 (목록에 표시됩니다)"
        />
        <label>사용자</label>
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="작성자 이름 (최대 10자)"
          maxLength={10}
          style={{ maxWidth: '200px', flex: 'none' }}
        />
      </div>
      {/* 그루핑 가능한 값 체크박스 (현재 채널 기준) — 아래 입력창과 동기화 */}
      <div className="value-picker">
        {ATTRS.map(([key, label]) => {
          const opts = distinct(key)
          if (!opts.length) return null
          return (
            <div className="picker-col" key={key}>
              <div className="picker-head">{label}</div>
              <div className="picker-list">
                {opts.map((v) => (
                  <label key={v} className="filter-item">
                    <input
                      type="checkbox"
                      checked={isChecked(key, v)}
                      onChange={() => toggleVal(key, v)}
                    />
                    <span>{v}</span>
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 수동 입력창 — 체크박스에 없는 값(예: 아직 접속 전 병동)도 쉼표로 추가 가능 */}
      <div className="criteria-grid">
        {ATTRS.map(([key, label]) => (
          <div className="row" key={key}>
            <label>{label}</label>
            <input
              value={criteria[key]}
              onChange={(e) => setCriteria({ ...criteria, [key]: e.target.value })}
              placeholder="쉼표로 여러 값 (OR)"
            />
          </div>
        ))}
      </div>
      <div className="row">
        <label>포함 채널</label>
        <input value={include} onChange={(e) => setInclude(e.target.value)} placeholder="CH0001, CH0002" />
        <label>제외 채널</label>
        <input value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="CH0003" />
      </div>
      <div className="actions">
        <button type="submit" className="primary">저장</button>
        {!isNew && group.id !== 'all' && (
          <button type="button" className="danger" onClick={() => onDelete(group.id)}>
            삭제
          </button>
        )}
        <button type="button" onClick={onCancel}>취소</button>
      </div>
      <p className="hint">
        위 체크박스(현재 접속 채널의 실제 값)와 아래 입력창(임의 값 직접 입력)은
        <b> 같은 조건을 공유</b>하므로 조합해서 쓸 수 있습니다.
        criteria 와 포함 채널이 모두 비어 있으면 <b>전체 채널</b>이 매칭됩니다.
        속성 간에는 AND, 한 속성의 여러 값은 OR, 제외 채널이 최우선입니다.
        저장 즉시 멤버십이 재계산되어 뷰어에 join/leave 로 전파됩니다.
      </p>
    </form>
  )
}
