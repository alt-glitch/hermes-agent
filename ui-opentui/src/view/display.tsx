/**
 * DisplayProvider — exposes the transcript display flags (store `compact` +
 * `details`, set by the /compact and /details utility commands) to deep view
 * nodes without threading the store through every layer (same pattern as
 * sessionInfo.tsx). Consumers: messageLine (compact spacing + hidden-mode part
 * folding), toolPart + reasoningPart (expanded-mode default-open). The fallback
 * accessor (no provider, e.g. a bare component test) is today's defaults:
 * compact off, details collapsed.
 */
import { type Accessor, createContext, type JSX, useContext } from 'solid-js'

import type { DetailsMode } from '../logic/details.ts'

export interface DisplayFlags {
  compact: boolean
  details: DetailsMode
  /** /timestamps: render a muted [HH:MM] next to each message that has a stored timestamp. */
  timestamps: boolean
  /** /reasoning full: expand all thinking sections (independent of `details`). */
  reasoningFull: boolean
}

const DEFAULTS: DisplayFlags = { compact: false, details: 'collapsed', timestamps: false, reasoningFull: false }
const DEFAULT_FLAGS: Accessor<DisplayFlags> = () => DEFAULTS

const Ctx = createContext<Accessor<DisplayFlags>>()

export function DisplayProvider(props: { flags: Accessor<DisplayFlags>; children: JSX.Element }) {
  return <Ctx.Provider value={props.flags}>{props.children}</Ctx.Provider>
}

/** The live display flags accessor (compact off + collapsed when no provider). */
export function useDisplay(): Accessor<DisplayFlags> {
  return useContext(Ctx) ?? DEFAULT_FLAGS
}
