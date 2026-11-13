/**
 * 入口垫片：真正的实现放在 lib/bundle.js。
 * package.json 的 main 指向 bundle.js —— 改代码后换入口名可以绕开进程内 ESM 模块缓存，
 * 不必等 App 重启就能让新代码生效。
 */
export * from './bundle.js'
