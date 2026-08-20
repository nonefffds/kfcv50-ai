const MODEL = "kfc-vivo-50";
const THINKING_MODEL = "kfc-vivo-50-r1";
const MODEL_CREATED = 1750000000;
const MODEL_CAPABILITIES = { streaming: true, tools: true, reasoning: true };

const WRONG_KEY_MESSAGE = (key) => `请使用api key ${key}`;
const CORRECT_KEY_MESSAGE = "KFC疯狂星期四vivo50";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_TOOLS = [
  {
    name: "kfc_vivo50",
    description: "Vivo 50 to KFC on Crazy Thursday. Returns the sacred incantation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crazy_thursday_check",
    description: "Check whether today is KFC Crazy Thursday. Returns the truth.",
    inputSchema: { type: "object", properties: {} },
  },
];
const MCP_RESOURCES = [
  {
    uri: "kfc://thursday",
    name: "Crazy Thursday Status",
    description: "Whether today is KFC Crazy Thursday",
    mimeType: "text/plain",
  },
  {
    uri: "kfc://guide",
    name: "Vivo50 使用指南",
    description: "How to do a proper Vivo50",
    mimeType: "text/plain",
  },
];
const MCP_PROMPTS = [
  {
    name: "kfc_vivo50",
    description: "Vivo 50 to KFC on Crazy Thursday",
    arguments: [
      { name: "amount", description: "金额，例如 50", required: false },
    ],
  },
];

const DELAYS = {
  normal: [100, 500],
  thinking: [2000, 5000],
  tool: [100, 500],
};
const randDelay = (kind) => {
  const [min, max] = DELAYS[kind] || DELAYS.normal;
  return min + Math.random() * (max - min);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const shortUuid = () => uuid().replace(/-/g, "");

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra },
  });

function errorResponse(message, status = 400, type = "invalid_request_error", param = null, code = "invalid_request_error") {
  return json({ error: { message, type, param, code } }, status);
}

function wantsThinking(model) {
  return /r1|think|reason/i.test(model);
}

function estimateTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  const ascii = (s.match(/[\x00-\x7f]/g) || []).length;
  const chars = Array.from(s).length;
  return Math.max(1, Math.round(ascii / 4 + (chars - ascii)));
}

function makeUsage(inputText, outputText) {
  const prompt_tokens = estimateTokens(inputText);
  const completion_tokens = estimateTokens(outputText);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function splitText(text, min = 2, max = 5) {
  const chars = Array.from(text);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const size = Math.min(chars.length - i, min + Math.floor(Math.random() * (max - min + 1)));
    out.push(chars.slice(i, i + size).join(""));
    i += size;
  }
  return out;
}

function extractKey(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = new URL(request.url);
  return url.searchParams.get("api_key") || url.searchParams.get("key") || "";
}

function resolveToolChoice(value) {
  if (value == null) return "auto";
  if (typeof value === "string") {
    const v = value.toLowerCase();
    return ["auto", "none", "required"].includes(v) ? v : "auto";
  }
  if (typeof value === "object") {
    const fn = value.function;
    const name =
      (typeof fn === "object" && fn && typeof fn.name === "string" && fn.name) ||
      (typeof value.name === "string" ? value.name : null);
    const type = value.type;
    if (type === "none") return "none";
    if (type === "required") return "required";
    if (type === "function" && name) return { type: "function", name };
    if (name) return { type: "function", name };
    if (type === "auto") return "auto";
  }
  return "auto";
}

function pickToolNames(tools, toolChoice) {
  const names = (tools || [])
    .filter((t) => t && typeof t === "object")
    .map((t) => (t.function && t.function.name) || t.name)
    .filter(Boolean);
  if (toolChoice === "none") return [];
  if (toolChoice && toolChoice.type === "function") {
    return names.includes(toolChoice.name) ? [toolChoice.name] : [];
  }
  if (toolChoice === "required" && names.length) {
    return [names[Math.floor(Math.random() * names.length)]];
  }
  return names;
}

function collectCallIds(messages) {
  const ids = new Set();
  for (const m of messages || []) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) ids.add(tc.id);
    }
  }
  return ids;
}

function collectBadToolIds(messages) {
  const ids = collectCallIds(messages);
  const bad = [];
  for (const m of messages || []) {
    if (m?.role === "tool" && m?.tool_call_id && !ids.has(m.tool_call_id)) bad.push(m.tool_call_id);
  }
  return [...new Set(bad)];
}

const SESSION_SSE = (response, stream) =>
  new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      ...CORS_HEADERS,
    },
  });

// ---------- /v1/chat/completions ----------

function completionBase(model = MODEL) {
  return {
    id: `chatcmpl-${uuid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function chatCompletion(msg, model = MODEL, extra = {}, usage) {
  return {
    ...completionBase(model),
    choices: [{ index: 0, message: { role: "assistant", content: msg, ...extra }, finish_reason: "stop" }],
    usage,
  };
}

function toolCallCompletion(names, model = MODEL, usage) {
  const tool_calls = names.map((name) => ({
    id: `call_${shortUuid()}`,
    type: "function",
    function: { name, arguments: "{}" },
  }));
  return {
    ...completionBase(model),
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls }, finish_reason: "tool_calls" }],
    usage,
  };
}

async function streamChat(controller, encoder, { model, thinking, reasoningChunks, textChunks, toolCalls, usage }) {
  const base = completionBase(model);
  const chunk = (delta, finish_reason = null, index = 0, extra = {}) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...base, choices: [{ index, delta, finish_reason }], ...extra })}\n\n`));

  if (toolCalls && toolCalls.length) {
    await sleep(randDelay("tool"));
    toolCalls.forEach((name, i) =>
      chunk(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ index: i, id: `call_${shortUuid()}`, type: "function", function: { name, arguments: "{}" } }],
        },
        null,
        i
      )
    );
    chunk({}, "tool_calls", 0, { usage });
    return;
  }

  if (thinking && reasoningChunks.length) {
    for (const c of reasoningChunks) {
      chunk({ role: "assistant", reasoning_content: c });
      await sleep(150 + Math.random() * 250);
    }
  }
  for (const c of textChunks) {
    chunk({ content: c });
    await sleep(30 + Math.random() * 60);
  }
  chunk({}, "stop", 0, { usage });
}

function chatStreamResponse(opts) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      await streamChat(controller, encoder, opts);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return SESSION_SSE(null, stream);
}

async function handleChat(request, env) {
  const key = extractKey(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400, "invalid_request_error", "body", "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be a JSON object", 400, "invalid_request_error", "body", "invalid_type");
  }
  if (body.messages === undefined) {
    return errorResponse("messages is required", 400, "invalid_request_error", "messages", "missing");
  }
  if (!Array.isArray(body.messages)) {
    return errorResponse("messages must be an array", 400, "invalid_request_error", "messages", "invalid_type");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return errorResponse("stream must be a boolean", 400, "invalid_request_error", "stream", "invalid_type");
  }

  const messages = body.messages;
  const model = typeof body.model === "string" && body.model ? body.model : MODEL;
  const stream = !!body.stream;
  const thinking = wantsThinking(model);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolChoice = resolveToolChoice(body.tool_choice);
  const hasToolResult = messages.some((m) => m?.role === "tool");
  const badToolIds = collectBadToolIds(messages);
  if (badToolIds.length) {
    return errorResponse(`tool_call_id not found: ${badToolIds[0]}`, 400, "invalid_request_error", "tool_call_id", "invalid_tool_call_id");
  }

  const wrong = key !== env.API_KEY;
  const msg = wrong ? WRONG_KEY_MESSAGE(env.API_KEY) : CORRECT_KEY_MESSAGE;
  const toolNames = pickToolNames(tools, toolChoice);
  const usage = makeUsage(JSON.stringify(messages), msg);

  if (toolNames.length && !hasToolResult) {
    if (stream) return chatStreamResponse({ model, toolCalls: toolNames, usage });
    await sleep(randDelay("tool"));
    return json(toolCallCompletion(toolNames, model, usage));
  }

  if (stream) {
    return chatStreamResponse({
      model,
      thinking,
      reasoningChunks: thinking ? splitText(msg, 4, 8) : [],
      textChunks: splitText(msg),
      usage,
    });
  }

  if (thinking) {
    await sleep(randDelay("thinking"));
    return json(chatCompletion(msg, model, { reasoning_content: msg }, usage));
  }

  await sleep(randDelay("normal"));
  return json(chatCompletion(msg, model, {}, usage));
}

// ---------- /v1/responses ----------

function responseBase(model) {
  return {
    id: `resp_${uuid()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
  };
}

function responsesInputParts(input) {
  const parts = { callIds: new Set(), badToolIds: [], hasToolResult: false, messages: [] };
  const items = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  for (const item of items) {
    if (typeof item === "string") {
      parts.messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      if (item.call_id) parts.callIds.add(item.call_id);
      parts.messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      parts.hasToolResult = true;
      if (item.call_id) {
        parts.messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output ?? "" });
        if (parts.callIds.size && !parts.callIds.has(item.call_id)) parts.badToolIds.push(item.call_id);
      }
      continue;
    }
    if (item.role) {
      parts.messages.push({ role: item.role, content: item.content });
      if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
        for (const tc of item.tool_calls) if (tc?.id) parts.callIds.add(tc.id);
      }
      if (item.role === "tool") {
        parts.hasToolResult = true;
        if (item.tool_call_id && parts.callIds.size && !parts.callIds.has(item.tool_call_id)) parts.badToolIds.push(item.tool_call_id);
      }
      continue;
    }
    parts.messages.push({ role: "user", content: item.content ?? "" });
  }
  parts.badToolIds = [...new Set(parts.badToolIds)];
  return parts;
}

function responseMessageItem(msg, thinking) {
  const content = [];
  if (thinking) content.push({ type: "reasoning", summary: [{ type: "summary_text", text: msg }] });
  content.push({ type: "output_text", text: msg });
  return { id: `msg_${shortUuid()}`, type: "message", status: "completed", role: "assistant", content };
}

function responseFunctionCallItem(name) {
  return {
    id: `fc_${shortUuid()}`,
    type: "function_call",
    status: "completed",
    call_id: `call_${shortUuid()}`,
    name,
    arguments: "{}",
    output: null,
  };
}

function responsesBody(model, { msg, toolNames, thinking, usage, instructions, prevId }) {
  const output = toolNames.length ? toolNames.map(responseFunctionCallItem) : [responseMessageItem(msg, thinking)];
  return {
    ...responseBase(model),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(prevId !== undefined ? { previous_response_id: prevId } : {}),
    output,
    usage,
  };
}

async function streamResponses(controller, encoder, { model, thinking, reasoningChunks, textChunks, toolCalls, usage, instructions, prevId }) {
  const base = responseBase(model);
  const event = (name, data) =>
    controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
  const withMeta = (extra) => ({ ...base, ...extra });
  const initial = withMeta({ status: "in_progress", instructions, previous_response_id: prevId, output: [], usage });

  event("response.created", { type: "response.created", response: initial });
  event("response.in_progress", { type: "response.in_progress", response: initial });

  if (toolCalls && toolCalls.length) {
    await sleep(randDelay("tool"));
    const items = [];
    toolCalls.forEach((name, i) => {
      const item = responseFunctionCallItem(name);
      items.push(item);
      event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: i,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      event("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: i,
        delta: "{}",
      });
      event("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: i,
        arguments: "{}",
      });
      event("response.output_item.done", { type: "response.output_item.done", output_index: i, item });
    });
    event("response.completed", {
      type: "response.completed",
      response: withMeta({ status: "completed", instructions, previous_response_id: prevId, output: items, usage }),
    });
    return;
  }

  const itemId = `msg_${shortUuid()}`;
  const outputIndex = 0;
  event("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
  });

  let contentIndex = 0;
  if (thinking && reasoningChunks.length) {
    const reasoningText = reasoningChunks.join("");
    event("response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part: { type: "reasoning", summary: [] },
    });
    for (const c of reasoningChunks) {
      await sleep(150 + Math.random() * 250);
      event("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        delta: c,
      });
    }
    event("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      text: reasoningText,
    });
    event("response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part: { type: "reasoning", summary: [{ type: "summary_text", text: reasoningText }] },
    });
    contentIndex += 1;
  }

  event("response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    part: { type: "output_text", text: "" },
  });
  for (const c of textChunks) {
    await sleep(30 + Math.random() * 60);
    event("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      delta: c,
    });
  }
  const text = textChunks.join("");
  event("response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    text,
  });
  event("response.content_part.done", {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    part: { type: "output_text", text },
  });

  const finalItem = responseMessageItem(text, thinking);
  finalItem.id = itemId;
  event("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item: finalItem });
  event("response.completed", {
    type: "response.completed",
    response: withMeta({ instructions, previous_response_id: prevId, output: [finalItem], usage }),
  });
}

function responsesStreamResponse(opts) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      await streamResponses(controller, encoder, opts);
      controller.close();
    },
  });
  return SESSION_SSE(null, stream);
}

async function handleResponses(request, env) {
  const key = extractKey(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400, "invalid_request_error", "body", "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be a JSON object", 400, "invalid_request_error", "body", "invalid_type");
  }
  if (body.input === undefined) {
    return errorResponse("input is required", 400, "invalid_request_error", "input", "missing");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return errorResponse("input must be a string or array", 400, "invalid_request_error", "input", "invalid_type");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return errorResponse("stream must be a boolean", 400, "invalid_request_error", "stream", "invalid_type");
  }

  const model = typeof body.model === "string" && body.model ? body.model : MODEL;
  const stream = !!body.stream;
  const thinking = wantsThinking(model);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolChoice = resolveToolChoice(body.tool_choice);
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
  const prevId = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;

  const parts = responsesInputParts(body.input);
  if (parts.badToolIds.length) {
    return errorResponse(`call_id not found: ${parts.badToolIds[0]}`, 400, "invalid_request_error", "call_id", "invalid_tool_call_id");
  }
  const hasToolResult = parts.hasToolResult;

  const wrong = key !== env.API_KEY;
  const msg = wrong ? WRONG_KEY_MESSAGE(env.API_KEY) : CORRECT_KEY_MESSAGE;
  const toolNames = pickToolNames(tools, toolChoice);
  const usage = makeUsage(JSON.stringify({ input: body.input, instructions }), msg);
  const opts = { model, thinking, usage, instructions, prevId };

  if (toolNames.length && !hasToolResult) {
    if (stream) return responsesStreamResponse({ ...opts, toolCalls: toolNames });
    await sleep(randDelay("tool"));
    return json(responsesBody(model, { msg, toolNames, thinking, usage, instructions, prevId }));
  }

  const textChunks = splitText(msg);
  const reasoningChunks = thinking ? splitText(msg, 4, 8) : [];
  if (stream) return responsesStreamResponse({ ...opts, reasoningChunks, textChunks });

  if (thinking) await sleep(randDelay("thinking"));
  else await sleep(randDelay("normal"));
  return json(responsesBody(model, { msg, toolNames: [], thinking, usage, instructions, prevId }));
}

// ---------- /v1/models ----------

function modelsList() {
  const mk = (id) => ({ id, object: "model", created: MODEL_CREATED, owned_by: "kfc", capabilities: MODEL_CAPABILITIES });
  return json({ object: "list", data: [mk(MODEL), mk(THINKING_MODEL)] });
}

// ---------- /mcp ----------

function wantsMcpSse(request) {
  return (request.headers.get("Accept") || "").includes("text/event-stream");
}

function mcpResponse(request, payload, extraHeaders = {}) {
  const headers = {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...CORS_HEADERS,
    ...extraHeaders,
  };
  if (wantsMcpSse(request)) {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...headers },
    });
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mcpJson(request, id, result, extraHeaders = {}) {
  return mcpResponse(request, { jsonrpc: "2.0", id, result }, extraHeaders);
}

function mcpError(request, id, code, message, extraHeaders = {}) {
  return mcpResponse(request, { jsonrpc: "2.0", id, error: { code, message } }, extraHeaders);
}

function thursdayText() {
  return new Date().getDay() === 4
    ? "今天就是疯狂星期四，Vivo50！"
    : "今天不是疯狂星期四，但 Vivo50 照常。";
}

async function handleMcp(request, env) {
  const key = extractKey(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return mcpError(request, null, -32700, "Parse error");
  }
  const { id, method } = body || {};
  const wrong = key !== env.API_KEY;
  const wrongMsg = WRONG_KEY_MESSAGE(env.API_KEY);
  const sessionId = request.headers.get("Mcp-Session-Id") || request.headers.get("mcp-session-id");
  const sH = sessionId ? { "Mcp-Session-Id": sessionId } : {};
  const ok = (id, result) => mcpJson(request, id, result, sH);
  const err = (id, code, message) => mcpError(request, id, code, message, sH);

  switch (method) {
    case "initialize":
      return mcpJson(
        request,
        id,
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: "kfcv50-ai", version: "1.2.0" },
          instructions: "Stateless KFC Vivo50 protocol simulator. Session IDs are cosmetic.",
        },
        { "Mcp-Session-Id": `sess_${shortUuid()}` }
      );
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, {
        status: 202,
        headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, ...CORS_HEADERS, ...sH },
      });
    case "ping":
      return wrong ? err(id, -32000, wrongMsg) : ok(id, {});
    case "tools/list":
      return wrong ? err(id, -32000, wrongMsg) : ok(id, { tools: MCP_TOOLS, nextCursor: null });
    case "tools/call": {
      if (wrong) return err(id, -32000, wrongMsg);
      const name = body?.params?.name;
      const text = name === "crazy_thursday_check" ? thursdayText() : CORRECT_KEY_MESSAGE;
      return ok(id, { content: [{ type: "text", text }], isError: false });
    }
    case "resources/list":
      return wrong ? err(id, -32000, wrongMsg) : ok(id, { resources: MCP_RESOURCES, nextCursor: null });
    case "resources/read": {
      if (wrong) return err(id, -32000, wrongMsg);
      const uri = body?.params?.uri;
      const resource = MCP_RESOURCES.find((r) => r.uri === uri);
      if (!resource) return err(id, -32602, `Unknown resource: ${uri}`);
      const text = uri === "kfc://thursday" ? thursdayText() : "Vivo50 三步走：打开支付宝 → 转账 50 → 备注「KFC疯狂星期四」。";
      return ok(id, { contents: [{ uri, mimeType: resource.mimeType, text }] });
    }
    case "resources/subscribe":
    case "resources/unsubscribe":
      return wrong ? err(id, -32000, wrongMsg) : ok(id, {});
    case "prompts/list":
      return wrong ? err(id, -32000, wrongMsg) : ok(id, { prompts: MCP_PROMPTS, nextCursor: null });
    case "prompts/get": {
      if (wrong) return err(id, -32000, wrongMsg);
      const name = body?.params?.name;
      if (name !== "kfc_vivo50") return err(id, -32602, `Unknown prompt: ${name}`);
      const amount = body?.params?.arguments?.amount;
      const text = amount
        ? `求求了，${amount} 也行，今天疯狂星期四。`
        : "Vivo50，今天疯狂星期四！";
      return ok(id, { messages: [{ role: "user", content: { type: "text", text } }] });
    }
    case "logging/setLevel":
      return wrong ? err(id, -32000, wrongMsg) : ok(id, {});
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ---------- router ----------

const ROUTES = [
  { re: /\/mcp\/?$/, method: "POST", handler: (request, env) => handleMcp(request, env) },
  { re: /\/models\/?$/, method: "GET", handler: () => modelsList() },
  { re: /\/chat\/completions\/?$/, method: "POST", handler: (request, env) => handleChat(request, env) },
  { re: /\/responses\/?$/, method: "POST", handler: (request, env) => handleResponses(request, env) },
];

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    for (const route of ROUTES) {
      if (route.re.test(url.pathname)) {
        if (request.method !== route.method) {
          return json(
            {
              error: {
                message: "Method Not Allowed",
                type: "invalid_request_error",
                param: null,
                code: "method_not_allowed",
              },
            },
            405,
            { Allow: route.method }
          );
        }
        return route.handler(request, env);
      }
    }

    return errorResponse("Not Found", 404, "invalid_request_error", null, "not_found");
  },
};
