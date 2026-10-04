import { writeFileSync } from 'node:fs'
import { buildOpenApi } from '../../api/src/openapi'

writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(buildOpenApi('/'), null, 2))
