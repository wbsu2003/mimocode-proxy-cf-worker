# mimo-proxy-cf-worker

Cloudflare Worker 版本的 mimo-proxy，行为对齐 Go 版 `mimo-proxy`。

> ## 🚨 重要：本上游与 Cloudflare Workers 架构性不兼容
>
> 经实测确认：**上游 `api.xiaomimimo.com` 会把 bootstrap 返回的 JWT 绑定到 bootstrap 请求的来源 IP**——该 token 只能从签发它的那个 IP 发起 chat，换 IP 即 `401 invalid_token`。
>
> Cloudflare Workers **没有固定出口 IP**：bootstrap 与 chat 是两个独立 `fetch`，会从不同的 CF 出口 IP（甚至不同数据中心）发出；KV 又是全球共享，一个 token 会被多机房复用。结果是 chat 的来源 IP 几乎永远对不上 bootstrap 的 IP，请求**间歇性/持续性 401**。
>
> **这不是本仓库代码的 bug，无法在 Worker 内修复**（免费版无法固定出口 IP；企业版需 Egress/Regional Services 专用出口）。
>
> **请改用固定出口 IP 的部署**：
> - 直接用原版 Go `mimo-proxy` 跑在 VPS / 家庭服务器上（它本就为此设计）。
> - 或把本 TS 适配到 Node/Bun/Deno，跑在有稳定出口 IP 的主机（VPS、Fly.io 专用 IP 等）。
>
> 验证方法：`curl https://<你的域名>/health` 永远 200（不连上游）；但真实 chat 请求会间歇 401。本仓库代码逻辑（协议转换、流式、鉴权、缓存）本身是正确的，换到单 IP 主机即可正常工作。

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
- 客户端指纹：bootstrap 时携带 `client` 指纹。**不建议设置 `MIMO_CLIENT_FINGERPRINT`**——见下方「⚠️ 指纹与防滥用」。未配置时每个 isolate 启动随机生成一个并在其生命周期内保持，这正是 Workers 环境下的推荐做法。
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

> ⚠️ 仓库里的 `id = "00000000000000000000000000000000"` 只是占位符。本地手动部署时需填入真实 id 才能让 KV 缓存生效（否则 JWT 无法跨 isolate 持久化，会退化为每个 isolate 各自 bootstrap，功能仍可用但更频繁）。**为避免把真实 id 误提交，填好后执行 `git update-index --skip-worktree wrangler.toml`**，git 就不再追踪你对该文件的本地改动。创建 KV namespace：`wrangler kv namespace create MIMO_JWT_KV`。

3. 可选：设置 API Key 与上游地址：

```bash
wrangler secret put MIMO_API_KEY
wrangler secret put MIMO_BASE_URL
```

5. 部署：

```bash
npm run deploy
```

## ⚠️ 指纹与防滥用（重要）

**不要设置 `MIMO_CLIENT_FINGERPRINT`。** 上游按 `client` 指纹做防滥用：同一个指纹被频繁 bootstrap 会被判定为滥用，导致该指纹签发的 token 被作废（返回 `401 invalid_token` / `403 illegal_access`）。

Go 原版是单进程、单指纹、单 token、后台慢刷新，所以从不触发。但 Cloudflare Worker 是**多 isolate**的：如果设了固定指纹，所有 isolate 都用同一个指纹各自 bootstrap，从 Cloudflare 共享出口 IP 看就像一个客户端在刷接口 → 触发防滥用 → 间歇性 401/403。

正确做法：

- **不设 `MIMO_CLIENT_FINGERPRINT`** → 每个 isolate 用自己随机生成、且生命周期内稳定的指纹，彼此独立、互不作废。
- **让 KV 缓存真正生效**(见第 2 步)→ 各 isolate 共享同一个 token，bootstrap 频率降到最低。
- 代码侧已有两道保护:同 isolate 内并发 bootstrap 用单飞合并;上游返回 401 时丢弃缓存、刷新并重试一次(403 不重试,以免加剧防滥用)。

排查时若看到间歇性 `Invalid Token`,且 KV namespace 显示「无读写」,基本就是这个问题:先删掉 `MIMO_CLIENT_FINGERPRINT`,再修好 KV 绑定。

## 通过 GitHub 部署

无论哪种方式，**前置准备都一样**：先按「手动部署」第 2 步建好真实 KV namespace 拿到 id，再用 `wrangler secret put` 设置好 `MIMO_API_KEY`（可选鉴权）。**不要设置 `MIMO_CLIENT_FINGERPRINT`**（见「⚠️ 指纹与防滥用」）。

> 🔒 关于 KV id：仓库内的 `wrangler.toml` **始终保留占位符 `00000000000000000000000000000000`**，真实 id 不入库，在部署时注入（下面两种方式各有做法）。

仓库已内置两个 workflow：

- `.github/workflows/ci.yml`：push / PR 时跑 `tsc --noEmit` 类型检查。
- `.github/workflows/deploy.yml`：push 到 `main`（或手动触发）时部署到 Cloudflare Workers。

### 方式一：Cloudflare 原生 Git 集成（Workers Builds，推荐）

GitHub 侧零密钥，由 Cloudflare 监听仓库：

1. Cloudflare 后台 → **Workers & Pages** → **Create** → **Connect to Git**。
2. 授权 GitHub，选择本仓库。
3. 在构建设置里加一个构建环境变量 `MIMO_JWT_KV_ID` = 真实 KV id。
4. 构建配置：Build command `npm ci`，Deploy command
   `sed -i "s/00000000000000000000000000000000/$MIMO_JWT_KV_ID/" wrangler.toml && npx wrangler deploy`，分支 `main`。
5. 保存。之后每次 `git push` 到 `main`，Cloudflare 自动构建并部署。

> 用方式一时不需要 `deploy.yml`，建议删除它（只保留 `ci.yml`），避免与 Cloudflare 的自动部署重复触发。

### 方式二：GitHub Actions 主动部署（使用内置 `deploy.yml`）

部署前可先跑类型检查作为门禁，控制权在 GitHub 侧。`deploy.yml` 会在部署前用 `sed` 把占位符替换成真实 KV id（只在 runner 内存发生，不写回仓库）。需配置三个仓库 secret：

1. **创建 API Token**：Cloudflare 后台 → My Profile → API Tokens → Create Token → 套用 **"Edit Cloudflare Workers"** 模板。
2. **获取 Account ID**：Workers & Pages 页面右侧栏。
3. GitHub repo → **Settings → Secrets and variables → Actions** 添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `MIMO_JWT_KV_ID`（真实 KV namespace id）

配好后 push 到 `main` 即触发部署，也可在 Actions 页面手动 **Run workflow**。

> ⚠️ 不要同时启用方式一和方式二的部署，否则一次 push 会触发两次部署、互相覆盖并浪费构建额度。`ci.yml` 只做检查不部署，可与任一方式共存。

| | 方式一 Workers Builds | 方式二 GitHub Actions |
|---|---|---|
| GitHub 配 secret | 不需要 | 需要 3 个 |
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
