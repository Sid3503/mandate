# @mandate/guard

Wraps an agent toolkit so the only tools that remain are ones Mandate already allows.

`classifyTool(name)` returns `read`, `propose`, or `null`.
 
`withMandate(tools, options)` keeps read tools, forwards propose tools to `POST /v1/proposals` through `options.client` (or calls `options.propose(name, input)`), and throws `unknown tool: <name>` for anything else. Pass `exposeRead: false` to drop the read tier (the `MCP_EXPOSE_READ_TOOLS` flag off).
 
```ts
import { withMandate } from './index.ts'

const safe = withMandate(toolkit, {
  client: {
    post: async (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body) }),
  },
})
```

No extra dependencies. Tests live in `api/test/phases.test.ts`.
