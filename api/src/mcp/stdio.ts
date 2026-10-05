// Run Mandate's MCP server over stdio, for Claude Desktop, Cursor, or the MCP Inspector:
//   MANDATE_MCP_SIDE=seller|buyer DATABASE_PATH=./data/mandate.sqlite node --import tsx src/mcp/stdio.ts
// It opens the same ledger the API uses. It has no PayPal credentials and no approve or capture tool.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { loadConfig } from '../config'
import { migrate, openDatabase, seed } from '../db/database'
import { loadSigner } from '../domain/signing'
import { buildServices } from '../services/container'
import { buyerPrincipal, STUDIO } from '../services/principal'
import { DEFAULT_BUDGET } from './http'
import { createMandateMcpServer } from './server'

const config = loadConfig(process.env)
const db = openDatabase(config.databasePath)
migrate(db)
seed(db, new Date())
const signer = loadSigner({
  pem: config.signingKey ?? undefined,
  previousPublicPems: config.previousPublicKeys,
  devKeyPath: join(dirname(config.databasePath), 'signing-key.pem'),
  production: config.nodeEnv === 'production',
})
const services = buildServices({ db, paypal: null, now: () => new Date(), signer })
const principal = process.env.MANDATE_MCP_SIDE === 'buyer' ? buyerPrincipal(config.buyerAgentParty) : STUDIO
const server = createMandateMcpServer({ services, principal, runId: randomUUID(), budget: { asks: DEFAULT_BUDGET } })
await server.connect(new StdioServerTransport())
console.error(JSON.stringify({ level: 'info', message: 'mandate mcp on stdio', side: principal.side }))
