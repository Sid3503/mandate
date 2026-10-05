import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useLocation, useOutlet } from 'react-router-dom'

/**
 * Screens leave and arrive instead of cutting. The outgoing screen fades up and away, the incoming one rises in,
 * and the page scrolls back to the top once the old one is gone. Reduced motion keeps the swap but drops the movement.
 */
export function PageTransition() {
  const outlet = useOutlet()
  const { pathname } = useLocation()
  const reduce = useReducedMotion()
  return (
    <AnimatePresence mode="wait" initial={false} onExitComplete={() => window.scrollTo({ top: 0 })}>
      <motion.div
        key={pathname}
        className="route"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
        transition={{ duration: reduce ? 0 : 0.22, ease: [0.2, 0.7, 0.2, 1] }}
      >
        {outlet}
      </motion.div>
    </AnimatePresence>
  )
}
