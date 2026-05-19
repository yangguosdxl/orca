import React from 'react'
import { AlertCircle, CheckCircle2, Download } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'

// Why: always rendered (not gated by `statusBarItems`). When the update card
// is collapsed, this segment is the only way back to it — hiding it would
// strand the user with an orphaned download or install.
export function UpdateStatusSegment({
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const status = useAppStore((s) => s.updateStatus)
  const collapsed = useAppStore((s) => s.updateCardCollapsed)
  const setCollapsed = useAppStore((s) => s.setUpdateCardCollapsed)

  if (
    status.state !== 'downloading' &&
    status.state !== 'downloaded' &&
    status.state !== 'preparing' &&
    status.state !== 'installing' &&
    status.state !== 'restarting' &&
    status.state !== 'recovery' &&
    status.state !== 'error'
  ) {
    return null
  }

  const segment = (() => {
    if (status.state === 'downloading') {
      const pct = Math.max(0, Math.min(100, Math.round(status.percent)))
      return {
        icon: <Download className="size-3 text-muted-foreground" />,
        label: `${pct}%`,
        tooltip: `Orca v${status.version} downloading… ${pct}%`,
        ariaLabel: `Update downloading, ${pct} percent. Click to expand.`
      }
    }
    if (status.state === 'downloaded') {
      return {
        icon: <CheckCircle2 className="size-3 text-emerald-500" />,
        label: 'Update ready',
        tooltip: `Orca v${status.version} ready to install`,
        ariaLabel: 'Update ready to install. Click to expand.'
      }
    }
    if (
      status.state === 'preparing' ||
      status.state === 'installing' ||
      status.state === 'restarting'
    ) {
      return {
        icon: <Download className="size-3 text-muted-foreground" />,
        label: 'Installing',
        tooltip: `Orca v${status.version} installing`,
        ariaLabel: 'Update installing. Click to expand.'
      }
    }
    if (status.state === 'recovery') {
      return {
        icon: <AlertCircle className="size-3 text-yellow-500" />,
        label: 'Update retry',
        tooltip: status.targetVersion
          ? `Orca v${status.targetVersion} update did not complete`
          : 'Previous update metadata was unreadable',
        ariaLabel: 'Update recovery. Click to expand.'
      }
    }
    return {
      icon: <AlertCircle className="size-3 text-yellow-500" />,
      label: 'Update failed',
      tooltip: 'Update failed — click to see details',
      ariaLabel: 'Update failed. Click to expand.'
    }
  })()

  const handleClick = () => {
    setCollapsed(!collapsed)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={segment.ariaLabel}
          aria-expanded={!collapsed}
        >
          {segment.icon}
          {!iconOnly && <span className="text-[11px] tabular-nums">{segment.label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {segment.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
