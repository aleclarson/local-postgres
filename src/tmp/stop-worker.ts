import { lowerWorkerPriority, parseWorkerPayload } from './worker'
import { stopTemporaryPostgres, type StopOptions } from './stop'

lowerWorkerPriority()

const { dataDir, expectedPid, options } = parseWorkerPayload<{
  dataDir: string
  expectedPid: number
  options: StopOptions
}>()

await stopTemporaryPostgres(dataDir, options, expectedPid)
