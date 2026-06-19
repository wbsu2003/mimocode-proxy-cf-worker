# mimo-proxy-cf-worker

Cloudflare Worker 版本的 mimo-proxy，行为对齐 Go 版 `mimo-proxy`。

> 原版（Go 实现）：https://github.com/myflavor/mimo-proxy
>
> 相关文章（介绍 / 部署教程）：https://laosu.tech/2026/06/18/MiMoCode免费API反向代理mimo-proxy

> ## ⚠️ 重要：上游 token 绑定来源 IP（CF 上可用但有延迟代价）
>
> 经实测确认：**上游 `api.xiaomimimo.com` 会把 bootstrap 返回的 JWT 绑定到 bootstrap 请求的来源 IP**——该 token 只能从签发它的那个 IP 发起 chat，换 IP 即 `401 invalid_token`。
>
> Cloudflare Workers **没有固定出口 IP**：bootstrap 与 chat 是两个独立 `fetch`，会从不同的 CF 出口 IP（甚至不同数据中心）发出。所以"缓存一个 token 复用"在 CF 上几乎必然失败（chat 的 IP 对不上 bootstrap 的 IP）。
>
> **本代理的应对（并发抢答）**：由于实测上游**没有 bootstrap 频率限制**、且**同一次调用里并发子请求的出口 IP 相互独立**，代码这样绕过：
> 1. **先单发**一次（用缓存/共享 token）——固定 IP 必中、CF 上约 40% 直接命中、缓存命中都走这条廉价路径，零额外开销；
> 2. 若 `401`，再**并发抢答**：一轮用一个全新 token 并发发 K 个 chat（`MIMO_CONCURRENT_CHAT`，默认 5），取首个成功、abort 其余；一轮命中率 ≈ `1 − 0.6^K`（K=5 ≈ 92%），最多 `MIMO_MAX_CONCURRENT_ROUNDS`（默认 2）轮 → ≈ 99%。
>
> **代价**：CF miss 时一次性并发 K 个 chat（约 0.4K 个会真正命中并启动推理，多余的被 abort，可能浪费少量上游算力）。换来的是延迟接近"一次 chat"——**实测 CF(东京 NRT 机房)上约 1.3~2.8 秒/请求**（单段 CF→上游往返 ~0.3s + 模型推理 ~1s）。
>
> **想要零代价 → 用固定出口 IP 的部署**（单发那一步必中，并发分支根本不触发；可开 `MIMO_USE_KV_CACHE=true` 复用 token）：
> - 直接用原版 Go `mimo-proxy`（https://github.com/myflavor/mimo-proxy）跑在 VPS / 家庭服务器 / NAS 上（它本就为此设计）。
> - **Docker 部署推荐**：`wbsu2003/mimo-proxy`（https://hub.docker.com/r/wbsu2003/mimo-proxy）。
> - 或让 Cloudflare 只做 DNS+反代，指向跑在固定 IP 主机上的后端。
>
> 相关可调 env：`MIMO_CONCURRENT_CHAT`（默认 5）、`MIMO_MAX_CONCURRENT_ROUNDS`（默认 2）、`MIMO_USE_KV_CACHE`（默认关；仅固定 IP 主机建议开）。
>
> 验证：`curl https://<你的域名>/health` 永远 200（不连上游）；真实 chat 请求在 CF 上应成功。

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

## 关于错误码与指纹（澄清）

- **`401 invalid_token`**：JWT 与当前 chat 请求的来源 IP 不匹配。根因见顶部「IP 绑定」警告——这是 CF Workers 上的主要失败原因。
- **`403 illegal_access`**：请求**缺少 anti-abuse 系统 marker**（`You are MiMoCode...`）。本代理会自动注入该 marker，所以正常不会出现；手动直连上游测试时若漏掉 marker 就会 403。**它与请求频率、指纹无关。**
- **客户端指纹**：经实测，上游**不**按指纹做频率防滥用，指纹也**不**影响 token 能否用于 chat（随机指纹照常工作）。因此**无需也不建议设置 `MIMO_CLIENT_FINGERPRINT`**，让每个实例用随机指纹即可。指纹不是失败原因——失败原因是上面的 IP 绑定。

> 注：曾一度怀疑"同指纹频繁 bootstrap 触发防滥用"，后经隔离实验证伪（同一 IP 快速多次 bootstrap+chat 全部成功）。真正的根因是 token 绑定来源 IP，见顶部警告。

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
