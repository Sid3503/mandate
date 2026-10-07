import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

/** The model's words as they arrive, with a caret while it is still writing. */
export function StreamText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <p className={`stream-text${streaming ? ' is-streaming' : ''}`} aria-hidden={streaming || undefined}>
      {text}
      {streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
    </p>
  )
}

/** Swaps the streamed words for the final, checked reply with a short crossfade, so a correction never jumps. */
export function Settle({ id, children }: { id: string; children: React.ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={id} initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
