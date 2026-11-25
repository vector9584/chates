// vitest 环境补丁：上游 apps/shared 的测试直接 new CloseEvent()，
// 但 node 环境只提供了 WebSocket，没有 CloseEvent 全局。
// tsconfig 里 lib 已含 DOM（类型在），这里补运行时实现即可，不改任何测试文件。
if (typeof globalThis.CloseEvent === 'undefined') {
  class CloseEventPolyfill extends Event {
    constructor(type, init = {}) {
      super(type)
      this.code = init.code ?? 0
      this.reason = init.reason ?? ''
      this.wasClean = init.wasClean ?? false
    }
  }
  globalThis.CloseEvent = CloseEventPolyfill
}
