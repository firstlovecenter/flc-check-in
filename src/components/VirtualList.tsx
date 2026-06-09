import { useRef, type ReactNode } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'

// Windowed list for potentially long rows (member lists, report timelines).
// Scrolls with the page (window) like the rest of the app — no inner scroll
// container. Short lists render plainly: virtualization only pays off (and
// only risks measurement quirks) once the DOM node count actually hurts.
export default function VirtualList<T>({
  items,
  renderRow,
  getKey,
  estimateSize = 74,
  gap = 8,
  threshold = 60,
}: {
  items: T[]
  renderRow: (item: T, index: number) => ReactNode
  getKey: (item: T, index: number) => string | number
  /** Expected row height in px — only an initial guess; rows self-measure. */
  estimateSize?: number
  gap?: number
  /** Below this many items, render a plain (non-virtual) list. */
  threshold?: number
}) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimateSize,
    overscan: 8,
    gap,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  })

  if (items.length <= threshold) {
    return (
      <div className='flex flex-col' style={{ gap }}>
        {items.map((item, i) => (
          <div key={getKey(item, i)}>{renderRow(item, i)}</div>
        ))}
      </div>
    )
  }

  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vi) => (
        <div
          key={getKey(items[vi.index], vi.index)}
          data-index={vi.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
          }}
        >
          {renderRow(items[vi.index], vi.index)}
        </div>
      ))}
    </div>
  )
}
