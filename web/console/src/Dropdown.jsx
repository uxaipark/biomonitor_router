import React, { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Custom dropdown (no native <select>): button + popover list with optional filter, groups, counts,
 * keyboard navigation (↑ ↓ Enter Esc), outside-click close.
 * options: [{ value, label, count?, group?, disabled? }]
 */
export default function Dropdown({ value, options, onChange, placeholder = '선택', searchable = true, className = '', width, disabled, renderValue }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(-1)
  const root = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const selected = options.find((o) => String(o.value) === String(value))
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? options.filter((o) => String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle)) : options
  }, [options, q])
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    setTimeout(() => inputRef.current?.focus(), 0)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('touchstart', onDoc) }
  }, [open])
  useEffect(() => { if (!open) { setQ(''); setHi(-1) } }, [open])
  useEffect(() => {
    if (hi < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-i="${hi}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hi])
  const pick = (o) => { if (o.disabled) return; onChange(o.value, o); setOpen(false) }
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (hi >= 0 && shown[hi]) pick(shown[hi]) }
  }
  // group headers are emitted when the group changes between consecutive shown items
  let lastGroup = null
  return (
    <div ref={root} className={'dd ' + className + (open ? ' open' : '') + (disabled ? ' disabled' : '')} style={width ? { width } : undefined}>
      <button type="button" className="dd-btn" disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) } }} aria-haspopup="listbox" aria-expanded={open}>
        <span className="dd-val">{selected ? (renderValue ? renderValue(selected) : <>{selected.label}{selected.count != null && <small> · {selected.count}</small>}</>) : <span className="dd-ph">{placeholder}</span>}</span>
        <i className="dd-caret" />
      </button>
      {open && (
        <div className="dd-menu" role="listbox">
          {searchable && options.length > 6 && <input ref={inputRef} className="dd-filter" placeholder="검색…" value={q} onChange={(e) => { setQ(e.target.value); setHi(0) }} onKeyDown={onKey} />}
          <ul ref={listRef} onKeyDown={onKey} tabIndex={-1}>
            {shown.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? <li key={'g' + o.group} className="dd-group">{o.group}</li> : null
              lastGroup = o.group ?? lastGroup
              return (
                <React.Fragment key={String(o.value)}>
                  {head}
                  <li data-i={i} role="option" aria-selected={String(o.value) === String(value)} className={'dd-item' + (String(o.value) === String(value) ? ' on' : '') + (i === hi ? ' hi' : '') + (o.disabled ? ' disabled' : '')} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
                    <span className="dd-label">{o.label}</span>
                    {o.count != null && <span className="dd-count">{o.count}명</span>}
                  </li>
                </React.Fragment>
              )
            })}
            {!shown.length && <li className="dd-empty">결과 없음</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
