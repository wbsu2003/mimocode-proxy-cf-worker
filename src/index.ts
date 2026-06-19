/**
 * mimo-proxy-cf-worker — Cloudflare Worker 版的 mimo-proxy（对齐 Go 版行为）。
 * 把 OpenAI / Anthropic 协议代理到小米 `api.xiaomimimo.com` 的免费 mimo-auto。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 踩坑记录与设计依据（务必读，否则很容易"改对成改错"）
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 【头号坑】上游把 bootstrap 返回的 JWT 绑定到 *bootstrap 请求的来源 IP*。
 *   token 只能从"签发它的那个 IP"发起 chat，换 IP → `401 invalid_token`。
 *   实证：让 Worker(CF 出口 IP) bootstrap 出 token，拿到另一台机器用 → 401；
 *   本机自己 bootstrap 的 token 本机用 → 200。
 *
 *   影响：Cloudflare Workers 没有固定出口 IP——bootstrap 与 chat 是两个独立
 *   `fetch`，会从不同 CF 出口 IP（甚至不同数据中心）发出。因此：
 *     - "缓存一个 token 全局复用"在 CF 上几乎必然失败（chat 的 IP 对不上
 *       bootstrap 的 IP）。KV 全球共享会把"偶尔撞中"变成"一致失败"，是帮倒忙。
 *     - 单机单 IP 部署（Go 版 / VPS / NAS）天然没这个问题，首个 token 当场可用、
 *       可缓存复用。
 *
 * 【解法】见 `fetchUpstreamConcurrent`：先用（可能缓存的）token 单发一次（覆盖固定 IP
 *   必中、CF 上约 40% 的幸运命中，零浪费）；若 401，再进入“并发抢答”——一轮里用同一个
 *   全新 token 并发发 K 个 chat（K=MIMO_CONCURRENT_CHAT，默认 5），取首个非 401 的响应、
 *   abort 其余。每个并发 chat 的出口 IP 相互独立（已实测：同批并发里 200/401 混合出现），
 *   所以一轮命中率 ≈ 1 − 0.6^K（K=5 ≈ 92%），最多 MIMO_MAX_CONCURRENT_ROUNDS 轮（默认 2）。
 *   之所以敢这样并发，是因为实测上游 *没有 bootstrap 频率限制*（见下）。
 *   代价：CF miss 时一次性发 K 个 chat（约 0.4K 个会真正命中并启动推理，多余的被 abort）。
 *   固定出口 IP 主机上：单发那一步就命中，并发分支根本不会触发（零额外开销）。
 *
 * 【两个被证伪的假设（曾据此走过弯路，勿重蹈）】
 *   1. `403 Illegal access` 不是"封 IP/防滥用"，而是 *请求缺少 anti-abuse 系统
 *      marker*（ANTI_ABUSE_MARKER）。本代理会自动注入，所以正常只会遇到 401 而非
 *      403；手动直连上游测试时若漏了 marker 就会 403，别误读成被封。
 *   2. 上游 *不* 按 `client` 指纹做频率防滥用，指纹也不影响 token 能否 chat
 *      （随机指纹照常工作）。同一 IP 快速连做多次 bootstrap+chat 全部成功 →
 *      无频率限制。因此 *无需也不建议设置 MIMO_CLIENT_FINGERPRINT*，随机即可。
 *
 * 【关于绑定的进一步实测（别再试这些"零成本根治"）】
 *   - `x-session-affinity` 一致性 *不能* 越过 IP 绑定。实验：Worker(CF IP) 用固定
 *     affinity bootstrap 出 token，再从另一 IP 用 *相同* affinity 去 chat → 仍 401。
 *     所以让 bootstrap/chat 复用同一个 affinity 值没用。
 *   - 绑定粒度是 *精确到源 IP*，不是 AS / 网段级（否则 CF 同 AS 出口命中率应接近
 *     100%，而实测仅约 40%，恰好是"单机房小出口池 2~3 个 IP 随机撞"的概率）。
 *   - 同一次 Worker 调用里发出的 *并发* 子请求，出口 IP 相互 *独立*（不会塌缩到一条
 *     连接/一个 IP），这正是“并发抢答”能提速的前提（已用 /debug/race 实测确认）。
 *
 * 【排查方法论】`/health` 不连上游、永远 200，用来测连通；要区分"代理 bug"还是
 *   "上游行为"，就直连上游、用与代理 *逐字节一致* 的请求（含 marker 与全部头）复刻；
 *   错误体是上游格式(`invalid_token`/`illegal_access`)还是代理格式
 *   (`authentication_error`) 能判断卡在哪一层。
 *
 * 【部署要点】`wrangler deploy` 会用 wrangler.toml 覆盖明文 vars，后台手填的明文
 *   变量会被清空 → 敏感值（MIMO_API_KEY）必须用 `wrangler secret put`（跨部署保留）。
 */
import type { KVNamespace } from "@cloudflare/workers-types";

interface Env {
  MIMO_BASE_URL?: string;
  MIMO_API_KEY?: string;
  API_KEY?: string;
  MIMO_JWT_KV?: KVNamespace;
  /**
   * 客户端指纹。不建议设置——上游不按指纹限流，固定值也无收益（见文件头）。
   * 未设置时每个 isolate 启动随机生成一个并在其生命周期内保持。
   */
  MIMO_CLIENT_FINGERPRINT?: string;
  /** 并发抢答时每轮并发的 chat 数（默认 5）。见文件头的 IP 绑定说明。 */
  MIMO_CONCURRENT_CHAT?: string;
  /** 单发失败后，并发抢答的最大轮数（默认 2）。 */
  MIMO_MAX_CONCURRENT_ROUNDS?: string;
  /**
   * 是否启用 KV 跨实例缓存 JWT。默认关闭（""/未设）。
   * 注意：上游 token 绑定来源 IP，跨机房共享一个 token 在 CF 上是帮倒忙
   * （详见文件头）。仅在“固定出口 IP 主机”上才建议设为 "true"。
   */
  MIMO_USE_KV_CACHE?: string;
}

interface JwtEntry {
  jwt: string;
  exp: number;
}

interface AnthropicMessage {
  role: string;
  content: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  [key: string]: unknown;
}

interface AnthropicThinking {
  type?: string;
  budget_tokens?: number;
}

interface AnthropicMetadata {
  user_id?: string;
  [key: string]: unknown;
}

interface AnthropicMessageRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  thinking?: AnthropicThinking;
  metadata?: AnthropicMetadata;
  [key: string]: unknown;
}

interface BlockState {
  index: number;
  blockType: "thinking" | "text" | "tool_use";
  closed: boolean;
  name?: string;
  toolCallId?: string;
}

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com";
const BOOTSTRAP_PATH = "/api/free-ai/bootstrap";
const CHAT_PATH = "/api/free-ai/openai/chat";
const SUPPORTED_MODEL = "mimo-auto";
const USER_AGENT = "mimocode/1.0.0";
const MIMO_SOURCE = "mimocode-cli-free";
const ANTI_ABUSE_MARKER = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const JWT_CACHE_KEY = "mimo-jwt";
const JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const JWT_CACHE_TTL_SECONDS = 60 * 60;
// 并发抢答的默认参数（可被 env 覆盖）。上游把 JWT 绑定到 bootstrap 的出口 IP，
// CF 出口 IP 不固定且并发子请求出口 IP 相互独立，故一轮 K 并发命中率 ≈ 1 − 0.6^K。
const DEFAULT_CONCURRENT_CHAT = 5;
const DEFAULT_MAX_CONCURRENT_ROUNDS = 2;
const MAX_CONCURRENT_CHAT = 20;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const jwtCache = new Map<string, JwtEntry>();
let bootstrapInFlight: Promise<JwtEntry> | null = null;
let fingerprintValue: string | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ ok: true, upstream: buildUpstreamUrl(env, CHAT_PATH) }, 200);
    }

    const authResult = checkApiKey(request, env);
    if (!authResult.ok) {
      return authResult.response;
    }

    try {
      switch (path) {
        case "/v1/models":
        case "/models":
          if (request.method !== "GET") return methodNotAllowed(["GET"]);
          return handleModels();
        case "/v1/chat/completions":
        case "/chat/completions":
          if (request.method !== "POST") return methodNotAllowed(["POST"]);
          return handleOpenAIChat(request, env, request.signal);
        case "/v1/messages":
        case "/messages":
          if (request.method !== "POST") return methodNotAllowed(["POST"]);
          return handleAnthropicMessages(request, env, request.signal);
        default:
          return jsonErrorResponse(404, "Not found", "invalid_request_error");
      }
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return jsonErrorResponse(413, error.message, "invalid_request_error");
      }
      return jsonErrorResponse(502, error instanceof Error ? error.message : String(error), "proxy_error");
    }
  },
};

function corsHeaders(): Headers {
  const headers = new Headers();
  applyCors(headers);
  return headers;
}

function applyCors(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function jsonResponse(body: unknown, status = 200): Response {
  const headers = corsHeaders();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-cache");
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonErrorResponse(status: number, message: string, type: string): Response {
  return jsonResponse({ error: { message, type } }, status);
}

function methodNotAllowed(allowed: string[]): Response {
  const headers = corsHeaders();
  headers.set("Allow", allowed.join(", "));
  return jsonResponse({ error: { message: "Method not allowed", type: "invalid_request_error" } }, 405);
}

function checkApiKey(request: Request, env: Env): { ok: true } | { ok: false; response: Response } {
  const configuredKey = env.MIMO_API_KEY || env.API_KEY;
  if (!configuredKey) return { ok: true };

  let key = "";
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) {
    key = authorization.slice("Bearer ".length).trim();
  }
  if (!key) {
    key = request.headers.get("x-api-key") || "";
  }

  if (!key) {
    return {
      ok: false,
      response: jsonErrorResponse(401, "missing API key (use Authorization: Bearer or x-api-key)", "authentication_error"),
    };
  }
  if (key !== configuredKey) {
    return { ok: false, response: jsonErrorResponse(401, "invalid API key", "authentication_error") };
  }
  return { ok: true };
}

function handleModels(): Response {
  return jsonResponse({
    object: "list",
    data: [
      {
        id: SUPPORTED_MODEL,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "xiaomimimo",
      },
    ],
  });
}

async function handleOpenAIChat(request: Request, env: Env, signal: AbortSignal): Promise<Response> {
  const bodyBytes = await readBody(request);
  const upstreamBody = ensureOpenAIMarker(bodyBytes);
  const upstream = await fetchUpstreamConcurrent(env, upstreamBody, signal);
  const headers = cloneResponseHeaders(upstream.headers);
  headers.set("Cache-Control", "no-cache");
  applyCors(headers);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handleAnthropicMessages(request: Request, env: Env, signal: AbortSignal): Promise<Response> {
  const bodyBytes = await readBody(request);
  let anthropicRequest: AnthropicMessageRequest;
  try {
    anthropicRequest = JSON.parse(textDecoder.decode(bodyBytes)) as AnthropicMessageRequest;
  } catch (error) {
    return jsonErrorResponse(400, error instanceof Error ? error.message : "Invalid JSON", "invalid_request_error");
  }

  const openAIRequest = anthropicToOpenAI(anthropicRequest);
  const openAIBody = textEncoder.encode(JSON.stringify(openAIRequest));
  const upstream = await fetchUpstreamConcurrent(env, openAIBody, signal);

  if (anthropicRequest.stream) {
    if (upstream.status >= 400) {
      const errorText = await safeText(upstream.body);
      return jsonResponse({ error: { type: "api_error", message: extractUpstreamErrorMessage(errorText) } }, upstream.status);
    }

    const headers = corsHeaders();
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("X-Accel-Buffering", "no");

    const transformer = new AnthropicStreamTransformer(openAIRequest, anthropicRequest.model ?? SUPPORTED_MODEL);
    const stream = upstream.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          transformer.transform(chunk, controller);
        },
        flush: (controller) => {
          transformer.flush(controller);
        },
      }),
    );

    return new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  const responseText = await safeText(upstream.body);
  if (upstream.status >= 400) {
    return jsonResponse({ error: { type: "api_error", message: extractUpstreamErrorMessage(responseText) } }, upstream.status);
  }

  return jsonResponse(openAIToAnthropic(responseText, anthropicRequest.model ?? SUPPORTED_MODEL), upstream.status);
}

class BodyTooLargeError extends Error {}

async function readBody(request: Request): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array(0);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return new Uint8Array(body);
}

function buildUpstreamUrl(env: Env, pathname: string): string {
  const base = (env.MIMO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}${pathname}`;
}

// fetchUpstreamWithToken：用 *指定* token 发一次 chat（供并发抢答里 K 个并发共享一个 token）。
async function fetchUpstreamWithToken(
  env: Env,
  body: Uint8Array,
  signal: AbortSignal,
  token: string,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Mimo-Source": MIMO_SOURCE,
    "x-session-affinity": `ses_${randomHex(12)}`,
    "User-Agent": USER_AGENT,
  });

  return fetch(buildUpstreamUrl(env, CHAT_PATH), {
    method: "POST",
    headers,
    body: new Blob([body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer]),
    signal,
  });
}

// 单发：用缓存/共享 token（getJwt）发一次。固定出口 IP 主机或缓存命中时，这一发即成。
async function fetchUpstream(env: Env, body: Uint8Array, signal: AbortSignal): Promise<Response> {
  return fetchUpstreamWithToken(env, body, signal, await getJwt(env));
}

function concurrentChatCount(env: Env): number {
  const n = Number(env.MIMO_CONCURRENT_CHAT);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENT_CHAT;
  return Math.min(MAX_CONCURRENT_CHAT, Math.floor(n));
}

function maxConcurrentRounds(env: Env): number {
  const n = Number(env.MIMO_MAX_CONCURRENT_ROUNDS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENT_ROUNDS;
  return Math.floor(n);
}

// fetchUpstreamConcurrent：本代理对外的统一入口，见文件头【解法】。
// 阶段一：用缓存/共享 token 单发一次——覆盖固定 IP 必中、CF 上约 40% 的幸运命中、缓存命中，
//         零额外开销（固定出口 IP 主机上永远走这条，不触发并发）。
// 阶段二：单发若 401（CF 上 token 的 bootstrap IP 对不上本次 chat 出口 IP），进入并发抢答：
//         每轮用一个全新 token 并发发 K 个 chat，取首个非 401、abort 其余；最多 rounds 轮。
async function fetchUpstreamConcurrent(env: Env, body: Uint8Array, signal: AbortSignal): Promise<Response> {
  const first = await fetchUpstream(env, body, signal);
  if (first.status !== 401) return first;
  await first.body?.cancel().catch(() => undefined);

  const k = concurrentChatCount(env);
  const rounds = maxConcurrentRounds(env);
  let last = first;
  for (let round = 0; round < rounds; round += 1) {
    const token = (await bootstrapJwt(env)).jwt;
    const winner = await raceChat(env, body, signal, token, k);
    if (winner.status !== 401) return winner;
    await winner.body?.cancel().catch(() => undefined);
    last = winner;
  }
  return last;
}

// raceChat：用同一个 token 并发发 k 个 chat，返回首个非 401 响应，并 abort 其余 + cancel 其 body。
// 之所以并发能提速：同一次调用里的并发子请求出口 IP 相互独立（已实测），各自约 40% 命中，
// 一轮命中率 ≈ 1 − 0.6^k。全部 401 → 返回一个合成的 401（其余 body 已全部清理，避免泄漏）。
async function raceChat(env: Env, body: Uint8Array, signal: AbortSignal, token: string, k: number): Promise<Response> {
  const controllers = Array.from({ length: k }, () => new AbortController());
  const responses: Array<Response | undefined> = new Array(k);

  // 客户端断开 → abort 全部子请求（赢家选出后仍保留此监听，以便流式途中客户端断开能取消上游）。
  const onClientAbort = () => controllers.forEach((c) => c.abort());
  if (signal.aborted) onClientAbort();
  else signal.addEventListener("abort", onClientAbort, { once: true });

  // 每个尝试：状态 <400 则 resolve(Response)，否则 reject（让 Promise.any 跳过 401）。
  const attempts = controllers.map((ctrl, i) =>
    fetchUpstreamWithToken(env, body, ctrl.signal, token).then((resp) => {
      responses[i] = resp;
      if (resp.status >= 200 && resp.status < 400) return resp;
      throw new Error(`upstream ${resp.status}`);
    }),
  );

  let winner: Response | null = null;
  try {
    winner = await Promise.any(attempts);
  } catch {
    winner = null; // 全部 reject（全 401 或网络错误）
  }

  const winnerIndex = winner ? responses.indexOf(winner) : -1;
  // abort 除赢家外仍在飞的子请求；赢家的 controller 不动，其 body 要回给客户端（含流式）。
  controllers.forEach((controller, i) => {
    if (i !== winnerIndex) controller.abort();
  });
  // 等全部尝试落定，确保 responses[] 填齐，再 cancel 非赢家已到达的 body。
  await Promise.allSettled(attempts);
  for (let i = 0; i < responses.length; i += 1) {
    if (i !== winnerIndex) await responses[i]?.body?.cancel().catch(() => undefined);
  }

  if (winner) return winner;
  return new Response(JSON.stringify({ error: { message: "Invalid Token", type: "invalid_token" } }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

// getJwt 返回共享/缓存的 JWT（先内存，KV 默认关、见 MIMO_USE_KV_CACHE），仅在缺失时才
// bootstrap。这是单发阶段用的 token；并发抢答阶段不走这里，而是每轮 bootstrap 全新 token
// 去并发撞 IP（详见 fetchUpstreamConcurrent 与文件头）。
async function getJwt(env: Env): Promise<string> {
  const cached = await readCachedJwt(env);
  if (cached) return cached.jwt;

  // 单飞：把同一 isolate 内并发的 bootstrap 合并成一次上游调用，对应 Go 版的 jwtMu 互斥锁。
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      try {
        const fresh = await bootstrapJwt(env);
        jwtCache.set(JWT_CACHE_KEY, fresh);
        await writeCachedJwt(env, fresh).catch(() => undefined);
        return fresh;
      } finally {
        bootstrapInFlight = null;
      }
    })();
  }

  const entry = await bootstrapInFlight;
  return entry.jwt;
}

async function readCachedJwt(env: Env): Promise<JwtEntry | null> {
  const inMemory = jwtCache.get(JWT_CACHE_KEY);
  if (inMemory && isJwtFresh(inMemory)) return inMemory;

  // KV 默认关：跨机房共享一个 token 在 CF 上会帮倒忙（token 绑定来源 IP，见文件头）。
  // 仅固定出口 IP 主机才建议开（MIMO_USE_KV_CACHE="true"）。
  if (env.MIMO_USE_KV_CACHE !== "true") return null;
  const kv = env.MIMO_JWT_KV;
  if (!kv) return null;

  try {
    const value = await kv.get<JwtEntry>(JWT_CACHE_KEY, "json");
    if (value?.jwt && isJwtFresh(value)) {
      jwtCache.set(JWT_CACHE_KEY, value);
      return value;
    }
  } catch {
    return null;
  }

  return null;
}

async function writeCachedJwt(env: Env, entry: JwtEntry): Promise<void> {
  if (env.MIMO_USE_KV_CACHE !== "true") return;
  const kv = env.MIMO_JWT_KV;
  if (!kv) return;
  await kv.put(JWT_CACHE_KEY, JSON.stringify(entry), { expirationTtl: JWT_CACHE_TTL_SECONDS });
}

function isJwtFresh(entry: JwtEntry): boolean {
  return typeof entry.exp === "number" && entry.exp - Date.now() > JWT_REFRESH_BUFFER_MS;
}

async function bootstrapJwt(env: Env): Promise<JwtEntry> {
  const body = JSON.stringify({ client: getFingerprint(env) });
  const response = await fetch(buildUpstreamUrl(env, BOOTSTRAP_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body,
  });

  if (!response.ok) {
    const text = await safeText(response.body);
    throw new Error(`mimo bootstrap ${response.status}: ${text}`);
  }

  let data: { jwt?: string };
  try {
    data = (await response.json()) as { jwt?: string };
  } catch (error) {
    throw new Error(`mimo bootstrap: ${error instanceof Error ? error.message : "invalid json"}`);
  }

  if (!data.jwt) {
    throw new Error("mimo bootstrap: missing jwt");
  }

  return { jwt: data.jwt, exp: parseJwtExp(data.jwt) };
}

function getFingerprint(env: Env): string {
  if (env.MIMO_CLIENT_FINGERPRINT) return env.MIMO_CLIENT_FINGERPRINT;
  if (!fingerprintValue) {
    fingerprintValue = randomHex(16);
  }
  return fingerprintValue;
}

function parseJwtExp(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return Date.now() + 50 * 60 * 1000;

  try {
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const payload = JSON.parse(textDecoder.decode(bytes)) as { exp?: number };
    if (payload.exp && payload.exp > 0) return payload.exp * 1000;
  } catch {
    // 解析失败，落到下面的默认 TTL。
  }

  return Date.now() + 50 * 60 * 1000;
}

function ensureOpenAIMarker(bodyBytes: Uint8Array): Uint8Array {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(textDecoder.decode(bodyBytes)) as Record<string, unknown>;
  } catch {
    return bodyBytes;
  }

  raw.model = SUPPORTED_MODEL;
  const messages = raw.messages;
  if (!Array.isArray(messages)) {
    return textEncoder.encode(JSON.stringify(raw));
  }

  const hasMarker =
    messages.length > 0 &&
    isRecord(messages[0]) &&
    messages[0].role === "system" &&
    containsMarker(extractText(messages[0].content));

  if (!hasMarker) {
    raw.messages = [{ role: "system", content: ANTI_ABUSE_MARKER }, ...messages];
  }

  return textEncoder.encode(JSON.stringify(raw));
}

function anthropicToOpenAI(req: AnthropicMessageRequest): Record<string, unknown> {
  const openAIRequest: Record<string, unknown> = {
    model: SUPPORTED_MODEL,
    messages: [] as unknown[],
    stream: Boolean(req.stream),
  };

  if (req.stream) openAIRequest.stream_options = { include_usage: true };
  if ((req.max_tokens ?? 0) > 0) openAIRequest.max_tokens = req.max_tokens;
  if (typeof req.temperature === "number") openAIRequest.temperature = req.temperature;
  if (typeof req.top_p === "number") openAIRequest.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) openAIRequest.stop = req.stop_sequences;

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    openAIRequest.tools = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? {},
      },
    }));
  }

  if (req.tool_choice !== undefined) openAIRequest.tool_choice = convertToolChoice(req.tool_choice);
  if (req.thinking?.type === "enabled" && typeof req.thinking.budget_tokens === "number" && req.thinking.budget_tokens > 0) {
    openAIRequest.thinking_budget = req.thinking.budget_tokens;
  }
  if (req.metadata?.user_id) openAIRequest.user = req.metadata.user_id;

  const messages = openAIRequest.messages as unknown[];
  const systemText = ensureSystemMarker(extractText(req.system));
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const message of req.messages ?? []) {
    const content = message.content;

    if (message.role === "assistant" && Array.isArray(content)) {
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCalls: unknown[] = [];

      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          reasoningParts.push(block.thinking);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id ?? randomID(),
            type: "function",
            function: {
              name: block.name ?? "",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      if (toolCalls.length > 0 || reasoningParts.length > 0) {
        const openAIMessage: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) openAIMessage.content = textParts.join("");
        if (reasoningParts.length > 0) openAIMessage.reasoning_content = reasoningParts.join("");
        if (toolCalls.length > 0) openAIMessage.tool_calls = toolCalls;
        messages.push(openAIMessage);
        continue;
      }
    }

    if (message.role === "user" && Array.isArray(content)) {
      const contentParts: unknown[] = [];
      const toolResults: unknown[] = [];

      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const imageUrl = extractImageURL(block);
          if (imageUrl) contentParts.push({ type: "image_url", image_url: { url: imageUrl } });
        } else if (block.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id ?? "",
            content: extractToolResultContent(block.content),
          });
        }
      }

      if (contentParts.length > 0) {
        messages.push({
          role: "user",
          content: contentParts.length === 1 && isTextContentPart(contentParts[0]) ? contentParts[0].text : contentParts,
        });
      }
      for (const toolResult of toolResults) messages.push(toolResult);
      continue;
    }

    messages.push({ role: message.role, content: extractText(content) });
  }

  return openAIRequest;
}

function openAIToAnthropic(openaiBody: string, requestedModel: string): Record<string, unknown> {
  let parsed: {
    id?: string;
    choices?: Array<{
      message?: {
        role?: string;
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  try {
    parsed = JSON.parse(openaiBody);
  } catch {
    return {
      id: `msg_${randomID()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: extractUpstreamErrorMessage(openaiBody) }],
      model: requestedModel || SUPPORTED_MODEL,
    };
  }

  const stopReason = parsed.choices?.[0]?.finish_reason != null ? mapFinishReason(parsed.choices[0].finish_reason) : "end_turn";
  const role = parsed.choices?.[0]?.message?.role || "assistant";
  const message = parsed.choices?.[0]?.message;
  const contentBlocks: unknown[] = [];

  if (message?.reasoning_content) contentBlocks.push({ type: "thinking", thinking: message.reasoning_content });
  if (message?.content) contentBlocks.push({ type: "text", text: message.content });
  for (const toolCall of message?.tool_calls ?? []) {
    const argumentsText = toolCall.function?.arguments || "{}";
    let input: unknown = {};
    try {
      input = JSON.parse(argumentsText);
    } catch {
      input = argumentsText;
    }
    contentBlocks.push({
      type: "tool_use",
      id: toolCall.id ?? randomID(),
      name: toolCall.function?.name ?? "",
      input,
    });
  }

  if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

  const response: Record<string, unknown> = {
    id: `msg_${randomID()}`,
    type: "message",
    role,
    content: contentBlocks,
    model: requestedModel || SUPPORTED_MODEL,
    stop_reason: stopReason,
  };

  if (parsed.usage) {
    response.usage = {
      input_tokens: parsed.usage.prompt_tokens ?? 0,
      output_tokens: parsed.usage.completion_tokens ?? 0,
    };
  }

  return response;
}

class AnthropicStreamTransformer {
  private buffer = "";
  private msgID = `msg_${randomID()}`;
  private started = false;
  private stopped = false;
  private outputTokens = 0;
  private inputTokens: number;
  private readonly blocks: BlockState[] = [];
  private readonly toolBlocks = new Map<number, BlockState>();
  private requestedModel: string;

  constructor(openAIRequest: Record<string, unknown>, requestedModel: string) {
    this.inputTokens = countTokens(openAIRequest);
    this.requestedModel = requestedModel || SUPPORTED_MODEL;
  }

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    this.buffer += textDecoder.decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleLine(line, controller);
    }
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.buffer.trim()) {
      this.handleLine(this.buffer, controller);
    }
    if (!this.stopped) {
      // 上游可能不发 [DONE]/finish_reason 就直接关闭连接。这里复用 [DONE] 的处理路径，
      // 确保客户端始终收到结构完整的事件序列。
      this.handleDone(controller);
    }
  }

  private handleLine(line: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (!line.startsWith("data: ")) return;
    const data = line.slice("data: ".length);
    if (data === "[DONE]") {
      this.handleDone(controller);
      return;
    }

    let chunk: {
      choices?: Array<{
        delta?: {
          role?: string;
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }

    if (!chunk.choices || chunk.choices.length === 0) return;
    const choice = chunk.choices[0];

    if (!this.started) {
      this.started = true;
      controller.enqueue(textEncoder.encode(this.emitSSE("message_start", {
        type: "message_start",
        message: {
          id: this.msgID,
          type: "message",
          role: "assistant",
          content: [],
          model: this.requestedModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      })));
    }

    if (choice.delta?.reasoning_content) {
      let thinkingBlock = this.findOpenBlock("thinking");
      if (!thinkingBlock) {
        thinkingBlock = this.allocBlock("thinking");
        controller.enqueue(textEncoder.encode(this.emitSSE("content_block_start", {
          type: "content_block_start",
          index: thinkingBlock.index,
          content_block: { type: "thinking", thinking: "" },
        })));
      }
      controller.enqueue(textEncoder.encode(this.emitSSE("content_block_delta", {
        type: "content_block_delta",
        index: thinkingBlock.index,
        delta: { type: "thinking_delta", thinking: choice.delta.reasoning_content },
      })));
    }

    if (choice.delta?.content) {
      this.closeOpenBlocks(["thinking"], controller);
      let textBlock = this.findOpenBlock("text");
      if (!textBlock) {
        textBlock = this.allocBlock("text");
        controller.enqueue(textEncoder.encode(this.emitSSE("content_block_start", {
          type: "content_block_start",
          index: textBlock.index,
          content_block: { type: "text", text: "" },
        })));
      }
      controller.enqueue(textEncoder.encode(this.emitSSE("content_block_delta", {
        type: "content_block_delta",
        index: textBlock.index,
        delta: { type: "text_delta", text: choice.delta.content },
      })));
    }

    for (const tc of choice.delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      let toolBlock = this.toolBlocks.get(index);
      if (!toolBlock) {
        this.closeOpenBlocks(["thinking", "text"], controller);
        toolBlock = this.allocBlock("tool_use");
        toolBlock.name = tc.function?.name ?? "";
        toolBlock.toolCallId = tc.id ?? randomID();
        this.toolBlocks.set(index, toolBlock);
        controller.enqueue(textEncoder.encode(this.emitSSE("content_block_start", {
          type: "content_block_start",
          index: toolBlock.index,
          content_block: {
            type: "tool_use",
            id: toolBlock.toolCallId,
            name: toolBlock.name,
            input: {},
          },
        })));
      }
      if (tc.function?.arguments) {
        controller.enqueue(textEncoder.encode(this.emitSSE("content_block_delta", {
          type: "content_block_delta",
          index: toolBlock.index,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        })));
      }
    }

    if (choice.finish_reason) {
      this.stopped = true;
      if (chunk.usage) {
        this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
        this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
      }
      this.emitStopEvents(controller, mapFinishReason(choice.finish_reason));
    }
  }

  private handleDone(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (!this.started) {
      this.started = true;
      controller.enqueue(textEncoder.encode(this.emitSSE("message_start", {
        type: "message_start",
        message: {
          id: this.msgID,
          type: "message",
          role: "assistant",
          content: [],
          model: this.requestedModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      })));
    }
    if (this.blocks.length === 0) {
      const emptyBlock = this.allocBlock("text");
      controller.enqueue(textEncoder.encode(this.emitSSE("content_block_start", {
        type: "content_block_start",
        index: emptyBlock.index,
        content_block: { type: "text", text: "" },
      })));
    }
    if (!this.stopped) {
      this.emitStopEvents(controller, "end_turn");
    }
  }

  private emitStopEvents(controller: TransformStreamDefaultController<Uint8Array>, stopReason: string): void {
    this.closeLastOpenBlock(controller);
    controller.enqueue(textEncoder.encode(this.emitSSE("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    })));
    controller.enqueue(textEncoder.encode(this.emitSSE("message_stop", { type: "message_stop" })));
  }

  private allocBlock(blockType: BlockState["blockType"]): BlockState {
    const block: BlockState = { index: this.blocks.length, blockType, closed: false };
    this.blocks.push(block);
    return block;
  }

  private findOpenBlock(blockType: BlockState["blockType"]): BlockState | undefined {
    return this.blocks.find((block) => block.blockType === blockType && !block.closed);
  }

  private closeOpenBlocks(
    blockTypes: BlockState["blockType"][],
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    for (const block of this.blocks) {
      if (blockTypes.includes(block.blockType) && !block.closed) {
        this.closeBlock(block, controller);
      }
    }
  }

  private closeLastOpenBlock(controller: TransformStreamDefaultController<Uint8Array>): void {
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      if (!this.blocks[i].closed) {
        this.closeBlock(this.blocks[i], controller);
        return;
      }
    }
  }

  private closeBlock(block: BlockState, controller?: TransformStreamDefaultController<Uint8Array>): void {
    if (block.closed) return;
    block.closed = true;
    if (controller) {
      controller.enqueue(textEncoder.encode(this.emitSSE("content_block_stop", {
        type: "content_block_stop",
        index: block.index,
      })));
    }
  }

  private emitSSE(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

function extractUpstreamErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // 解析失败，继续往下走。
  }
  return body || "[upstream response parse error]";
}

async function safeText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const buffer = await new Response(body).arrayBuffer();
  return textDecoder.decode(buffer);
}

function cloneResponseHeaders(headers: Headers): Headers {
  const clone = new Headers(headers);
  for (const hopByHop of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    clone.delete(hopByHop);
  }
  return clone;
}

function ensureSystemMarker(systemText: string): string {
  if (containsMarker(systemText)) return systemText;
  return systemText ? `${ANTI_ABUSE_MARKER}\n\n${systemText}` : ANTI_ABUSE_MARKER;
}

function containsMarker(text: string): boolean {
  return text.includes(ANTI_ABUSE_MARKER);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRecord(item)) return "";
        if (typeof item.text === "string") return item.text;
        if (typeof item.thinking === "string") return item.thinking;
        return "";
      })
      .join("");
  }
  return "";
}

function extractImageURL(block: Record<string, unknown>): string {
  const source = block.source;
  if (!isRecord(source)) return "";

  if (source.type === "base64") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "";
    const data = typeof source.data === "string" ? source.data : "";
    if (mediaType && data) return `data:${mediaType};base64,${data}`;
  }

  if (source.type === "url" && typeof source.url === "string") {
    return source.url;
  }

  return "";
}

function extractToolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRecord(item)) return "";
        return typeof item.text === "string" ? item.text : "";
      })
      .join("");
  }
  return "";
}

function convertToolChoice(value: unknown): unknown {
  if (!isRecord(value)) return value;
  switch (value.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      if (typeof value.name === "string" && value.name) {
        return { type: "function", function: { name: value.name } };
      }
      return "auto";
    default:
      return "auto";
  }
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return reason;
  }
}

function countTokens(value: unknown): number {
  const body = JSON.stringify(value);
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body.charCodeAt(i) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.floor(ascii / 4) + Math.floor((nonAscii * 2) / 3);
}

function randomID(): string {
  return randomHex(16);
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function isTextContentPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}
