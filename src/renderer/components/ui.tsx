import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`card ${className}`}>
      {title ? <div className="card-title">{title}</div> : null}
      {children}
    </div>
  )
}

export function Spinner({ size = 18 }: { size?: number }): JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function EmptyState({ icon = 'downloads', text, action }: { icon?: IconName; text: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      <div className="icon">
        <Icon name={icon} size={44} />
      </div>
      <div>{text}</div>
      {action}
    </div>
  )
}

export function StatCard({ label, value, icon, tone }: { label: string; value: string | number; icon: IconName; tone?: 'accent' | 'success' | 'danger' | 'warning' | 'info' }): JSX.Element {
  return (
    <div className="stat-card">
      <div className="label">
        <Icon name={icon} size={15} />
        {label}
      </div>
      <div className={`value ${tone ? `badge ${tone}` : ''}`} style={tone ? { fontSize: 20, alignSelf: 'flex-start' } : undefined}>
        {value}
      </div>
    </div>
  )
}

export function ProgressBar({ percent, tone, indeterminate }: { percent: number; tone?: 'success' | 'danger'; indeterminate?: boolean }): JSX.Element {
  const p = Math.min(100, Math.max(0, percent))
  return (
    <div className="progress-track">
      {indeterminate ? (
        <div className={`progress-fill indeterminate ${tone ?? ''}`} />
      ) : (
        <div className={`progress-fill ${tone ?? ''}`} style={{ width: `${p}%` }} />
      )}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
    </label>
  )
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <Icon name="clear" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / Math.pow(1024, i)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatSpeed(bytesPerSec?: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '--'
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatEta(seconds?: number): string {
  if (!seconds || seconds <= 0) return '--:--'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
