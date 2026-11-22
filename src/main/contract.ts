// What other programs rely on in a build: the MCP tools agents call, where they reach screen-ink, and the shape of
// the settings saved on disk. `npm run dev` builds this on its own, with Electron and npm packages stubbed out, and
// compares a new build's contract with the running one's to tell a safe reload from one that breaks connected
// sessions. It prints the contract as JSON.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PORT } from './config'
import { buildServer } from './mcp'
import { DEFAULTS } from './settings'

export interface Contract {
  port: number
  instructions: string
  tools: { name: string; description?: string; inputSchema: unknown }[]
  settings: Record<string, string>
}

async function contract(): Promise<Contract> {
  const server = buildServer()
  const client = new Client({ name: 'screen-ink-contract', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  const instructions = client.getInstructions() ?? ''
  await client.close()
  return {
    port: PORT,
    instructions,
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })).sort((x, y) => x.name.localeCompare(y.name)),
    settings: Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, typeof v])),
  }
}

contract().then(
  c => {
    process.stdout.write(JSON.stringify(c))
    process.exit(0)
  },
  e => {
    console.error(e)
    process.exit(1)
  },
)
