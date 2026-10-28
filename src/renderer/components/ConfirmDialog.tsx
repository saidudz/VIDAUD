import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useApp } from '../AppContext'
import { Button } from './Button'
import { Icon } from './Icon'

export interface ConfirmDialogOptions {
  title: string
  message: string
  detail?: string
  danger?: boolean
}

interface ConfirmDialogProps extends ConfirmDialogOptions {
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, message, detail, danger, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const confirm = useCallback((): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    window.setTimeout(onConfirm, 150)
  }, [onConfirm])

  const cancel = useCallback((): void => {
    if (busyRef.current) return
    busyRef.current = true
    onCancel()
  }, [onCancel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (busyRef.current) return
      if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, cancel])

  return (
    <div className="modal-overlay confirm-overlay" onClick={cancel}>
      <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-header">
          {danger ? (
            <span className="confirm-warn-icon">
              <Icon name="alert" size={18} />
            </span>
          ) : null}
          <h2 className="confirm-title">{title}</h2>
        </div>
        <p className="confirm-message">{message}</p>
        {detail ? <p className="confirm-detail">{detail}</p> : null}
        <div className="confirm-actions">
          <Button autoFocus variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={confirm}>
            {busy ? t('confirm.processing') : t('confirm.yes')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t('confirm.no')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialogHost(): JSX.Element | null {
  const { confirmState, resolveConfirm } = useApp()
  if (!confirmState) return null
  return (
    <ConfirmDialog
      title={confirmState.title}
      message={confirmState.message}
      detail={confirmState.detail}
      danger={confirmState.danger}
      onConfirm={() => resolveConfirm(true)}
      onCancel={() => resolveConfirm(false)}
    />
  )
}
