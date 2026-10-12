# @mandate/guard

Wraps an agent toolkit so the only tools that remain are ones Mandate already allows.

`classifyTool(name)` returns `read`, `propose`, or `null`.

`withMandate(tools, options)` keeps read tools, sends propose tools to `options.propose`, and throws `unknown tool: <name>` for anything else. Pass `exposeRead: false` to drop the read tier (the `MCP_EXPOSE_READ_TOOLS` flag off).

```ts
import { withMandate } from './index.ts'

const safe = withMandate(toolkit, {
  propose: async (name, input) => fetch('/v1/proposals', { method: 'POST', body: JSON.stringify(input) }),
})
```

No extra dependencies. Tests live in `api/test/phases.test.ts`.
