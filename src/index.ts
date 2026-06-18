import type { KVNamespace } from "@cloudflare/workers-types";

interface Env {
  MIMO_BASE_URL?: string;
  MIMO_API_KEY?: string;
  API_KEY?: string;
  MIMO_JWT_KV?: KVNamespace;
  MIMO_CLIENT_FINGERPRINT?: string;
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const jwtCache = new Map<string, JwtEntry>();
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
  const upstream = await fetchUpstream(env, upstreamBody, signal);
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
  const upstream = await fetchUpstream(env, openAIBody, signal);

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

async function fetchUpstream(env: Env, body: Uint8Array, signal: AbortSignal): Promise<Response> {
  const jwt = await getJwt(env);
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
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

async function getJwt(env: Env): Promise<string> {
  const cached = await readCachedJwt(env);
  if (cached) return cached.jwt;

  const entry = await bootstrapJwt(env);
  jwtCache.set(JWT_CACHE_KEY, entry);
  await writeCachedJwt(env, entry).catch(() => undefined);
  return entry.jwt;
}

async function readCachedJwt(env: Env): Promise<JwtEntry | null> {
  const inMemory = jwtCache.get(JWT_CACHE_KEY);
  if (inMemory && isJwtFresh(inMemory)) return inMemory;

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
    // Fall through to default TTL.
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
      // Upstream may close without a [DONE]/finish_reason. Mirror the [DONE]
      // path so the client always receives a well-formed event sequence.
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
    // Fall through.
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
