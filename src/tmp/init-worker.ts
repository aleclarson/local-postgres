import type { PostgresBinaryOptions } from '../types'
import { initdb } from '../tmp'
import { lowerWorkerPriority, parseWorkerPayload } from './worker'

lowerWorkerPriority()

const { dataDir, postgres } = parseWorkerPayload<{
  dataDir: string
  postgres?: PostgresBinaryOptions
}>()

await initdb(dataDir, { postgres, stdio: 'inherit' })
