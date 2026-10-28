/// <reference types="vite/client" />

import type { VidaudApi } from '@shared/types'

declare global {
  interface Window {
    vidaud: VidaudApi
  }
}

export {}
