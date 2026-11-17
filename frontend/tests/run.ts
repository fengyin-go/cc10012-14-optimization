/**
 * node:test 统一入口：所有 *.test.ts 由 esbuild 打包后在此被加载执行。
 */
import './anomaly-engine.test.ts'
import './anomaly-scenario.test.ts'
import './anomaly-store.test.ts'
