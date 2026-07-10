import { defineConfig } from 'tsdown'
import ApiSnapshot from 'tsnapi/rolldown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/tmp.ts',
    'src/tmp/init-worker.ts',
    'src/tmp/stop-worker.ts',
  ],
  format: ['esm'],
  dts: true,
  plugins: [ApiSnapshot()],
})
