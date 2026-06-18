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

## 手动部署 (Wrangler CLI)

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

## 通过 GitHub 部署

无论哪种方式，**前置准备都一样**：先按「手动部署」第 2 步建好真实 KV namespace 并填进 `wrangler.toml`，再用 `wrangler secret put` 设置好 `MIMO_API_KEY` / `MIMO_CLIENT_FINGERPRINT` 等密钥（这些存在 Cloudflare 侧，不进 GitHub）。

仓库已内置两个 workflow：

- `.github/workflows/ci.yml`：push / PR 时跑 `tsc --noEmit` 类型检查。
- `.github/workflows/deploy.yml`：push 到 `main`（或手动触发）时部署到 Cloudflare Workers。

### 方式一：Cloudflare 原生 Git 集成（Workers Builds，推荐）

GitHub 侧零密钥，由 Cloudflare 监听仓库：

1. Cloudflare 后台 → **Workers & Pages** → **Create** → **Connect to Git**。
2. 授权 GitHub，选择本仓库。
3. 构建配置：Build command `npm ci`，Deploy command `npx wrangler deploy`，分支 `main`。
4. 保存。之后每次 `git push` 到 `main`，Cloudflare 自动构建并部署。

> 用方式一时不需要 `deploy.yml`，建议删除它（只保留 `ci.yml`），避免与 Cloudflare 的自动部署重复触发。

### 方式二：GitHub Actions 主动部署（使用内置 `deploy.yml`）

部署前可先跑类型检查作为门禁，控制权在 GitHub 侧。需配置两个仓库 secret：

1. **创建 API Token**：Cloudflare 后台 → My Profile → API Tokens → Create Token → 套用 **"Edit Cloudflare Workers"** 模板。
2. **获取 Account ID**：Workers & Pages 页面右侧栏。
3. GitHub repo → **Settings → Secrets and variables → Actions** 添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

配好后 push 到 `main` 即触发部署，也可在 Actions 页面手动 **Run workflow**。

> ⚠️ 不要同时启用方式一和方式二的部署，否则一次 push 会触发两次部署、互相覆盖并浪费构建额度。`ci.yml` 只做检查不部署，可与任一方式共存。

| | 方式一 Workers Builds | 方式二 GitHub Actions |
|---|---|---|
| GitHub 配 secret | 不需要 | 需要 2 个 |
| 部署前自定义 CI | 受限 | 完全自由 |
| 触发 | push 自动 | push 自动 + 手动 |
| 维护成本 | 最低 | 中 |

部署完成后用 `/health` 和一次真实 chat 请求验证（类型检查挡不住「KV id 仍是占位符」这类配置问题）。

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
