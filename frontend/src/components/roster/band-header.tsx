/** Section rule: label, hairline, count. Deliberately quiet — the cards below
 *  it carry the urgency, and a loud header competes with them for it. */
export function BandHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mt-6 mb-2.5 flex items-center gap-2.5">
      <h2 className="text-muted-foreground font-heading text-xs font-semibold tracking-[0.1em] uppercase">
        {label}
      </h2>
      <div className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-xs">{count}</span>
    </div>
  )
}
