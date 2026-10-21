import type { UserConfig } from 'tsdown'

// clean stays off so tsdown keeps the declarations tsc emits into lib/types.
export default { entry: ['src/index.ts', 'src/mcp.ts'], outDir: 'lib', format: ['esm'], fixedExtension: false, dts: false, clean: false } satisfies UserConfig
