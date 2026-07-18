/**
 * A stable avatar for a traveller, from DiceBear's `thumbs` style.
 *
 * The photoreal route (randomuser.me, thispersondoesnotexist) was tried and
 * dropped. thispersondoesnotexist has no seed, so a face changes on every
 * refresh; randomuser.me is seedable but splits its portraits into men/women
 * sets, and picking the set by hash put male faces on Grace and Nora. An
 * arbitrary-but-stable choice still reads as a bug to anyone looking at it.
 *
 * `thumbs` has no gender to get wrong. It takes the seed directly, so the
 * employee id pins each person to one avatar permanently, and it is visibly
 * synthetic — which is the honest thing for a roster of fictional travellers.
 *
 * Initials render underneath at all times, so an offline demo degrades to a
 * monogram rather than a hole.
 */
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

function avatarUrl(seed: string) {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}`
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = parts[0].charAt(0)
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : ""
  return (first + last).toUpperCase()
}

export function Avatar({
  name,
  seed,
  size = 36,
  className,
}: {
  name: string
  /** Defaults to the name; pass employeeId so renames don't reroll the avatar. */
  seed?: string
  size?: number
  className?: string
}) {
  const key = seed ?? name
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [key])

  return (
    <span
      role="img"
      aria-label={name}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
      className={cn(
        "bg-muted text-muted-foreground relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none",
        className
      )}
    >
      {initials(name)}
      {!failed && (
        <img
          src={avatarUrl(key)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  )
}
