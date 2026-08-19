const MODEL = "kfc-vivo-50";
const THINKING_MODEL = "kfc-vivo-50-r1";
const WRONG_KEY_MESSAGE = (key) => `请使用api key ${key}`;
const CORRECT_KEY_MESSAGE = "KFC疯狂星期四vivo50";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function completionBase(model = MODEL) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function chatCompletion(content, model = MODEL, extra = {}) {
  return {
    ...completionBase(model),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...extra },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function toolCallCompletion(name, model = MODEL) {
  return {
    ...completionBase(model),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
              type: "function",
              function: { name, arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function streamCompletion(content, model = MODEL, thinking = false, toolName = null) {
  const base = completionBase(model);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      const chunk = (delta, finish_reason = null) =>
        send({ ...base, choices: [{ index: 0, delta, finish_reason }] });

      if (toolName) {
        chunk(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
                type: "function",
                function: { name: toolName, arguments: "{}" },
              },
            ],
          },
          null
        );
        chunk({}, "tool_calls");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }

      if (thinking) {
        chunk({ role: "assistant", reasoning_content: content });
        await sleep(2000 + Math.random() * 3000);
        chunk({ content });
        chunk({}, "stop");
      } else {
        chunk({ role: "assistant", content });
        chunk({}, "stop");
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      ...CORS_HEADERS,
    },
  });
}

function modelsList() {
  return json({
    object: "list",
    data: [
      {
        id: MODEL,
        object: "model",
        created: 0,
        owned_by: "kfc",
      },
      {
        id: THINKING_MODEL,
        object: "model",
        created: 0,
        owned_by: "kfc",
      },
    ],
  });
}

function extractKey(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = new URL(request.url);
  return url.searchParams.get("api_key") || url.searchParams.get("key") || "";
}

function wantsThinking(model) {
  return /r1|think|reason/i.test(model);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && /\/models\/?$/.test(url.pathname)) {
      return modelsList();
    }

    if (request.method === "POST" && /\/chat\/completions\/?$/.test(url.pathname)) {
      const key = extractKey(request);
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const model = typeof body?.model === "string" ? body.model : MODEL;
      const stream = !!body?.stream;
      const thinking = wantsThinking(model);
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      const toolName = tools[0]?.function?.name || null;
      const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m) => m?.role === "tool");

      const msg = key !== env.API_KEY ? WRONG_KEY_MESSAGE(env.API_KEY) : CORRECT_KEY_MESSAGE;

      if (toolName && !hasToolResult) {
        return stream
          ? streamCompletion(msg, model, false, toolName)
          : json(toolCallCompletion(toolName, model));
      }

      if (stream) {
        return streamCompletion(msg, model, thinking);
      }

      if (thinking) {
        return (async () => {
          await sleep(2000 + Math.random() * 3000);
          return json(
            chatCompletion(msg, model, { reasoning_content: msg })
          );
        })();
      }

      return json(chatCompletion(msg, model));
    }

    return json(
      {
        error: {
          message: "Not Found",
          type: "invalid_request_error",
          param: null,
          code: "not_found",
        },
      },
      404
    );
  },
};
