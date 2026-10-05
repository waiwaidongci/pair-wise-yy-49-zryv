// 生产启动入口：node start.js（等价于 build/index.js，但补齐直连场景的协议头）。
//
// 反代部署时 x-forwarded-proto / x-forwarded-host 通常已由反代写入，这里不覆盖；
// 本地直连（dev 预览或无反代直挂）时这些头缺失，adapter-node 会默认按 https 处理，
// 导致表单 Origin(http) 与服务端 URL(https) 不一致，被 CSRF 保护误判为跨站提交。
// 此处在缺失时补齐 http 与 Host，两种部署形态都能正确工作。
import http from 'node:http'

// 告诉 adapter-node 从这些头识别协议 / 主机（默认未设置时会一律按 https 处理）。
// 必须在动态导入 build/handler.js 之前设置——处理器在模块加载时就读取这两个变量。
process.env.PROTOCOL_HEADER ||= 'x-forwarded-proto'
process.env.HOST_HEADER ||= 'x-forwarded-host'
const protoHeader = process.env.PROTOCOL_HEADER.toLowerCase()
const hostHeader = process.env.HOST_HEADER.toLowerCase()

const { handler } = await import('./build/handler.js')

const server = http.createServer((req, res) => {
  if (!req.headers[protoHeader]) req.headers[protoHeader] = 'http'
  if (!req.headers[hostHeader]) req.headers[hostHeader] = req.headers.host
  return handler(req, res)
})

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'
server.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
