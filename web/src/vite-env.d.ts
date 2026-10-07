/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The AG Studio trial or enterprise licence key. Optional: Studio works without one locally, with a watermark. Never commit it. */
  readonly VITE_AG_STUDIO_LICENSE?: string
}

/** Which build this is. Set by Vite at build time. */
declare const __RELEASE__: string
