import { useRef, useState, useEffect, type MouseEvent, type TouchEvent } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

interface SignatureModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (dataUrl: string) => void
}

const FONTS = [
  { name: 'Dancing Script', family: '"Dancing Script", cursive, sans-serif' },
  { name: 'Great Vibes', family: '"Great Vibes", cursive, sans-serif' },
  { name: 'Caveat', family: '"Caveat", cursive, sans-serif' },
  { name: 'Sacramento', family: '"Sacramento", cursive, sans-serif' }
]

const COLORS = ['#000000', '#1a237e', '#b71c1c', '#004d40']

export function SignatureModal({ isOpen, onClose, onSave }: SignatureModalProps): JSX.Element | null {
  const { t } = useI18n()
  const [mode, setMode] = useState<'draw' | 'type'>('draw')
  const [typedName, setTypedName] = useState('')
  const [selectedFont, setSelectedFont] = useState(FONTS[0].family)
  const [selectedColor, setSelectedColor] = useState(COLORS[0])
  const [hasDrawn, setHasDrawn] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const isDrawing = useRef(false)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setHasDrawn(false)
    setTypedName('')
    // Clear canvas
    setTimeout(() => {
      const cv = canvasRef.current
      if (cv) {
        const ctx = cv.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, cv.width, cv.height)
        }
      }
    }, 50)
  }, [isOpen])

  if (!isOpen) return null

  const getCanvasCoords = (e: MouseEvent<HTMLCanvasElement> | TouchEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current
    if (!cv) return { x: 0, y: 0 }
    const rect = cv.getBoundingClientRect()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    const scaleX = cv.width / rect.width
    const scaleY = cv.height / rect.height
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    }
  }

  const startDrawing = (e: MouseEvent<HTMLCanvasElement> | TouchEvent<HTMLCanvasElement>) => {
    isDrawing.current = true
    const pt = getCanvasCoords(e)
    lastPoint.current = pt
    setHasDrawn(true)
  }

  const draw = (e: MouseEvent<HTMLCanvasElement> | TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || !lastPoint.current) return
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const currentPt = getCanvasCoords(e)
    ctx.strokeStyle = selectedColor
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    ctx.beginPath()
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y)
    ctx.lineTo(currentPt.x, currentPt.y)
    ctx.stroke()

    lastPoint.current = currentPt
  }

  const stopDrawing = () => {
    isDrawing.current = false
    lastPoint.current = null
  }

  const clearCanvas = () => {
    const cv = canvasRef.current
    if (cv) {
      const ctx = cv.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, cv.width, cv.height)
      }
    }
    setHasDrawn(false)
  }

  const handleApply = () => {
    if (mode === 'draw') {
      const cv = canvasRef.current
      if (!cv || !hasDrawn) return
      onSave(cv.toDataURL('image/png'))
    } else {
      if (!typedName.trim()) return
      // Render typed text onto hidden offscreen canvas
      const cv = document.createElement('canvas')
      cv.width = 600
      cv.height = 180
      const ctx = cv.getContext('2d')
      if (ctx) {
        ctx.font = `64px ${selectedFont}`
        ctx.fillStyle = selectedColor
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(typedName, cv.width / 2, cv.height / 2)
        onSave(cv.toDataURL('image/png'))
      }
    }
    onClose()
  }

  const isValid = mode === 'draw' ? hasDrawn : typedName.trim().length > 0

  return (
    <div className="modal-backdrop">
      <div className="signature-modal" onClick={(e) => e.stopPropagation()}>
        <div className="signature-header">
          <h3>{t('pdf.addSignature') || 'Add Signature'}</h3>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="clear" size={16} />
          </button>
        </div>

        <div className="signature-tabs">
          <button
            className={`signature-tab ${mode === 'draw' ? 'active' : ''}`}
            onClick={() => setMode('draw')}
          >
            <Icon name="edit" size={15} />
            {t('pdf.drawSignature') || 'Draw'}
          </button>
          <button
            className={`signature-tab ${mode === 'type' ? 'active' : ''}`}
            onClick={() => setMode('type')}
          >
            <Icon name="document" size={15} />
            {t('pdf.typeSignature') || 'Type'}
          </button>
        </div>

        <div className="signature-body">
          {mode === 'draw' ? (
            <div className="signature-canvas-wrap">
              <canvas
                ref={canvasRef}
                width={500}
                height={160}
                className="signature-canvas"
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                onTouchStart={startDrawing}
                onTouchMove={draw}
                onTouchEnd={stopDrawing}
              />
              <div className="signature-canvas-hint">
                <span>{t('pdf.signHere') || 'Sign here with mouse or stylus'}</span>
                {hasDrawn ? (
                  <button className="signature-clear-btn" onClick={clearCanvas}>
                    {t('common.clear') || 'Clear'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="signature-type-wrap">
              <input
                type="text"
                className="input signature-type-input"
                placeholder={t('pdf.typeYourName') || 'Type your name'}
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                autoFocus
              />
              <div className="signature-font-picker">
                {FONTS.map((f) => (
                  <button
                    key={f.name}
                    className={`signature-font-option ${selectedFont === f.family ? 'selected' : ''}`}
                    style={{ fontFamily: f.family, color: selectedColor }}
                    onClick={() => setSelectedFont(f.family)}
                  >
                    {typedName || f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="signature-color-picker">
            <label>{t('pdf.color') || 'Color'}:</label>
            <div className="signature-colors">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`color-dot ${selectedColor === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setSelectedColor(c)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="signature-footer">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!isValid} onClick={handleApply}>
            {t('pdf.insertSignature') || 'Insert Signature'}
          </Button>
        </div>
      </div>
    </div>
  )
}
