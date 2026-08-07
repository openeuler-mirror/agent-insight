'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from '@/lib/client/locale-context'

interface Props {
  label?: string
  children: ReactNode
  widthClass?: string
  side?: 'bottom' | 'right'
}

const VIEWPORT_PAD = 8
const GAP = 8

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Compact “?” help control. Renders the tip via portal + fixed positioning so
 * parent overflow (modals, tables, scroll panes) cannot clip it.
 */
export function HelpTip({
  label,
  children,
  widthClass = 'w-72',
  side = 'bottom',
}: Props) {
  const { locale } = useLocale()
  const tipLabel = label ?? (locale === 'zh' ? '说明' : 'Help')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({
    top: 0,
    left: 0,
    visibility: 'hidden',
  })

  const updatePosition = useCallback(() => {
    const button = buttonRef.current
    const tip = tipRef.current
    if (!button || !tip) return

    const rect = button.getBoundingClientRect()
    const tipWidth = tip.offsetWidth
    const tipHeight = tip.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const maxLeft = Math.max(VIEWPORT_PAD, vw - tipWidth - VIEWPORT_PAD)
    const maxTop = Math.max(VIEWPORT_PAD, vh - tipHeight - VIEWPORT_PAD)

    let top: number
    let left: number

    if (side === 'right') {
      left = rect.right + GAP
      top = rect.top + rect.height / 2 - tipHeight / 2
      if (left + tipWidth > vw - VIEWPORT_PAD) {
        left = rect.left - tipWidth - GAP
      }
    } else {
      left = rect.left + rect.width / 2 - tipWidth / 2
      top = rect.bottom + GAP
      if (top + tipHeight > vh - VIEWPORT_PAD) {
        top = rect.top - tipHeight - GAP
      }
    }

    setStyle({
      top: clamp(top, VIEWPORT_PAD, maxTop),
      left: clamp(left, VIEWPORT_PAD, maxLeft),
      visibility: 'visible',
    })
  }, [side])

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ top: 0, left: 0, visibility: 'hidden' })
      return
    }
    updatePosition()
  }, [open, updatePosition, children, widthClass])

  useEffect(() => {
    if (!open) return
    const onReposition = () => updatePosition()
    window.addEventListener('resize', onReposition)
    // Capture scroll from overflow parents (dialog body, tables, etc.).
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, updatePosition])

  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={tipLabel}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-foreground-muted hover:border-foreground-muted"
        style={{ cursor: 'help' }}
      >
        ?
      </button>
      {open
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              className={`pointer-events-none fixed z-[100] ${widthClass} rounded-md border border-border bg-card px-3 py-2 text-xs leading-relaxed text-foreground-secondary shadow-md`}
              style={style}
            >
              {children}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}

interface LabelProps {
  children: ReactNode
  tip: ReactNode
  tipLabel?: string
  className?: string
}

export function LabelWithHelp({ children, tip, tipLabel, className }: LabelProps) {
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      {children}
      <HelpTip label={tipLabel}>{tip}</HelpTip>
    </span>
  )
}
