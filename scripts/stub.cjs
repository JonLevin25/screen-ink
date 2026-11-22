// Loaded with `node -r` before the contract reader (src/main/contract.ts), which runs outside Electron: Electron and
// npm packages other than the MCP SDK and zod are replaced by a harmless function that returns another one.
const Module = require('node:module')

const KEEP = /^(@modelcontextprotocol\/sdk|zod)(\/|$)/
const stub = new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' || key === '__esModule' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
})

const load = Module._load
Module._load = function (request, ...rest) {
  if (/^[^./]/.test(request) && !request.startsWith('node:') && !Module.isBuiltin(request) && !KEEP.test(request)) return stub
  return load.call(this, request, ...rest)
}
