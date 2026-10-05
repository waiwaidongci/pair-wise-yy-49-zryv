import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type PluginOption } from 'vite'

// 让 SvelteKit dev 服务器从这些头识别协议 / 主机（未设置时默认按 https，会造成直连 CSRF 误拦）。
process.env.PROTOCOL_HEADER ||= 'x-forwarded-proto'
process.env.HOST_HEADER ||= 'x-forwarded-host'

// dev 直连时补齐协议头，避免表单 Origin 与服务端 URL 协议不一致。
function devProtocolHeaders(): PluginOption {
  return {
    name: 'dev-protocol-headers',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (!req.headers['x-forwarded-proto']) req.headers['x-forwarded-proto'] = 'http'
        if (!req.headers['x-forwarded-host']) req.headers['x-forwarded-host'] = req.headers.host
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [tailwindcss(), devProtocolHeaders(), sveltekit()],
  server: { port: 62049, host: true },
})
