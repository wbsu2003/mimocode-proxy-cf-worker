# mimo-proxy-cf-worker

Cloudflare Worker 版本的 mimo-proxy，行为对齐 Go 版 `mimo-proxy`。

## 功能

- `/health` 健康检查，不需要 API Key。
- OpenAI 兼容：
  - `/v1/chat/completions`
  - `/chat/completions`
  - 非流式转发
  - 流式转发
- Anthropic 兼容：
  - `/v1/messages`
  - `/messages`
  - 非流式转换为 Anthropic `message`
  - 流式转换为 Anthropic SSE
- API Key 认证：配置 `MIMO_API_KEY` 后，请求头使用 `Authorization: Bearer <key>` 或 `x-api-key: <key>`。
- 默认上游：`https://api.xiaomimimo.com`，可通过 `MIMO_BASE_URL` 覆盖。
- 自动 bootstrap 到 `/api/free-ai/bootstrap` 获取 JWT。
- JWT 优先使用 KV binding `MIMO_JWT_KV` 缓存；没有 KV 或写入失败时，会在请求时 bootstrap 后直接使用。
- 客户端指纹：bootstrap 时携带 `client` 指纹。配置 `MIMO_CLIENT_FINGERPRINT` 则固定使用该值；未配置时每个 isolate 启动随机生成一个并在其生命周期内保持。
- 上游请求强制：
  - `model=mimo-auto`
  - `Authorization: Bearer <jwt>`
  - `X-Mimo-Source: mimocode-cli-free`
  - `x-session-affinity: ses_<randomHex>`
  - `User-Agent: mimocode/1.0.0`
- 缺失 system marker 时自动补入：`You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.`

## 部署

1. 安装依赖：

```bash
npm install
```

2. 替换 `wrangler.toml` 中 `MIMO_JWT_KV` 的真实 KV namespace id：

```toml
[[kv_namespaces]]
binding = "MIMO_JWT_KV"
id = "你的真实_KV_namespace_id"
preview_id = "mimo_proxy_jwt_preview"
```

> ⚠️ 仓库里的 `id = "00000000000000000000000000000000"` 只是占位符。**部署前必须换成真实 id**，否则 KV 缓存不生效，JWT 无法跨 isolate 持久化——会退化为每个 isolate 各自 bootstrap。功能仍可用，但 bootstrap 调用会明显变频繁。创建 KV namespace：`wrangler kv namespace create MIMO_JWT_KV`。

3. 可选：设置 API Key 与上游地址：

```bash
wrangler secret put MIMO_API_KEY
wrangler secret put MIMO_BASE_URL
```

4. 推荐：固定客户端指纹（生产环境）：

```bash
wrangler secret put MIMO_CLIENT_FINGERPRINT
```

> Worker 是无状态的，isolate 会被频繁创建/销毁。未配置 `MIMO_CLIENT_FINGERPRINT` 时，每个新 isolate 会生成不同的随机指纹，导致 bootstrap 时上报的 `client` 持续漂移、刷新更频繁。生产环境建议显式配置一个稳定值（任意足够随机的字符串即可，例如 `openssl rand -hex 16` 的输出）。

5. 部署：

```bash
npm run deploy
```

## 本地开发

```bash
npm install
MIMO_API_KEY=test-key npm run dev
```

本地验证示例：

```bash
curl http://localhost:8787/health
curl http://localhost:8787/models
curl -H "Authorization: Bearer wrong" http://localhost:8787/models
curl http://localhost:8787/not-found
```

真实上游调用需要可用的 `MIMO_BASE_URL` 和 MiMoCode bootstrap 服务；缺少密钥或上游不可达时，Worker 仍会返回认证/路径类本地验证结果，但聊天请求会失败并返回代理错误。
