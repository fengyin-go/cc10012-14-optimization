/**
 * 测试打包器：用项目已有的 esbuild 把 TS 测试（含 @ 路径别名）打成单文件，
 * 再交给 node 内置 test runner 执行，不引入额外测试依赖。
 */
import { build } from 'esbuild'
import { fileURLToPath, URL } from 'node:url'
import { rmSync } from 'node:fs'

const entry = fileURLToPath(new URL('../tests/run.ts', import.meta.url))
const outfile = fileURLToPath(new URL('../node_modules/.cache/anomaly-tests.mjs', import.meta.url))

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  target: 'node20',
  alias: {
    '@': fileURLToPath(new URL('../src', import.meta.url)),
  },
  logLevel: 'info',
})

try {
  // 动态加载打包产物，node:test 在进程内收集并执行用例。
  await import(`file://${outfile}`)
} finally {
  rmSync(outfile, { force: true })
}
