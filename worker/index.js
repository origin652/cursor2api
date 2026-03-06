export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }

      // Health
      if (url.pathname === '/health') {
        return json({ status: 'ok', runtime: 'cloudflare-worker', version: 'worker-0.1.0' });
      }

      // Root
      if (url.pathname === '/') {
        return json({
          name: 'cursor2api-worker',
          version: 'worker-0.1.0',
          runtime: 'cloudflare-worker',
          endpoints: {
            anthropic_messages: 'POST /v1/messages',
            openai_chat: 'POST /v1/chat/completions',
            models: 'GET /v1/models',
            health: 'GET /health',
          },
        });
      }

      // Models
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const model = env.CURSOR_MODEL || 'anthropic/claude-sonnet-4.6';
        return json({
          object: 'list',
          data: [{ id: model, object: 'model', created: 1700000000, owned_by: 'anthropic' }],
        });
      }

      // Anthropic Messages API
      if (request.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/messages')) {
        return await handleAnthropicMessages(request, env);
      }

      // OpenAI Chat Completions API
      if (request.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
        return await handleOpenAIChatCompletions(request, env);
      }

      return withCors(new Response('Not Found', { status: 404 }));
    } catch (err) {
      return withCors(json({ error: String(err?.message || err) }, 500));
    }
  },
};

async function handleAnthropicMessages(request, env) {
  const body = await request.json();
  const stream = !!body.stream;

  const cursorReq = convertAnthropicToCursor(body, env);

  if (stream) {
    const textEncoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // message_start
          controller.enqueue(textEncoder.encode(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: randomId('msg_'),
              type: 'message',
              role: 'assistant',
              model: body.model || env.CURSOR_MODEL || 'anthropic/claude-sonnet-4.6',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`));

          // content_block_start
          controller.enqueue(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`));

          let fullText = '';
          await sendCursorRequest(cursorReq, env, (delta) => {
            fullText += delta;
            controller.enqueue(textEncoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta },
            })}\n\n`));
          });

          // content_block_stop
          controller.enqueue(textEncoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`));

          // message_delta
          controller.enqueue(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: estimateTokens(fullText) },
          })}\n\n`));

          // message_stop
          controller.enqueue(textEncoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`));
          controller.close();
        } catch (err) {
          controller.enqueue(textEncoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: String(err?.message || err) })}\n\n`));
          controller.close();
        }
      },
    });

    return withCors(new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }));
  }

  const fullText = await sendCursorRequestFull(cursorReq, env);

  const resp = {
    id: randomId('msg_'),
    type: 'message',
    role: 'assistant',
    model: body.model || env.CURSOR_MODEL || 'anthropic/claude-sonnet-4.6',
    content: [{ type: 'text', text: fullText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: estimateTokens(fullText),
    },
  };

  return json(resp);
}

async function handleOpenAIChatCompletions(request, env) {
  const body = await request.json();
  const stream = !!body.stream;

  // OpenAI -> Anthropic-like input -> Cursor
  const anthropicLike = openAIToAnthropic(body);
  const cursorReq = convertAnthropicToCursor(anthropicLike, env);

  if (stream) {
    const id = randomId('chatcmpl-');
    const created = Math.floor(Date.now() / 1000);

    const textEncoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // initial role chunk
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          })}\n\n`));

          await sendCursorRequest(cursorReq, env, (delta) => {
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: body.model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`));
          });

          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`));

          controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta: { content: `\n\n[Error: ${String(err?.message || err)}]` }, finish_reason: 'stop' }],
          })}\n\n`));
          controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return withCors(new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }));
  }

  const fullText = await sendCursorRequestFull(cursorReq, env);
  const usage = {
    prompt_tokens: 0,
    completion_tokens: estimateTokens(fullText),
    total_tokens: estimateTokens(fullText),
  };

  return json({
    id: randomId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
    usage,
  });
}

function openAIToAnthropic(body) {
  const messages = [];
  let system = '';

  for (const m of body.messages || []) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') system += (system ? '\n\n' : '') + m.content;
      continue;
    }

    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({
        role: m.role,
        content: normalizeOpenAIContentToText(m.content),
      });
      continue;
    }

    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: `[Tool Result]\n${normalizeOpenAIContentToText(m.content)}`,
      });
    }
  }

  return {
    model: body.model,
    messages,
    system: system || undefined,
    stream: !!body.stream,
    max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
  };
}

function normalizeOpenAIContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        if (x?.type === 'text') return x.text || '';
        if (x?.type === 'image_url') return '[Image attached]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function convertAnthropicToCursor(req, env) {
  const model = env.CURSOR_MODEL || req.model || 'anthropic/claude-sonnet-4.6';

  const messages = [];
  if (req.system) {
    messages.push({
      id: shortId(),
      role: 'user',
      parts: [{ type: 'text', text: String(req.system) }],
    });
  }

  for (const msg of req.messages || []) {
    messages.push({
      id: shortId(),
      role: msg.role,
      parts: [{ type: 'text', text: extractAnthropicText(msg.content) }],
    });
  }

  return {
    model,
    id: shortId(),
    trigger: 'submit-message',
    messages,
  };
}

function extractAnthropicText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');

  const parts = [];
  for (const b of content) {
    if (b?.type === 'text' && b?.text) parts.push(b.text);
    else if (b?.type === 'tool_result') {
      parts.push(`[Tool Result] ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`);
    } else if (b?.type === 'tool_use') {
      parts.push(`\`\`\`json action\n${JSON.stringify({ tool: b.name, parameters: b.input || {} }, null, 2)}\n\`\`\``);
    } else if (b?.type === 'image') {
      parts.push('[Image attached]');
    }
  }
  return parts.join('\n\n');
}

async function sendCursorRequestFull(cursorReq, env) {
  let full = '';
  await sendCursorRequest(cursorReq, env, (delta) => {
    full += delta;
  });
  return full;
}

async function sendCursorRequest(cursorReq, env, onDelta) {
  const apiUrl = env.CURSOR_CHAT_API || 'https://cursor.com/api/chat';
  const timeoutMs = Number(env.CURSOR_TIMEOUT_MS || 120000);

  const headers = {
    'content-type': 'application/json',
    'sec-ch-ua-platform': '"Windows"',
    'x-path': '/api/chat',
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'x-method': 'POST',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-platform-version': '"19.0.0"',
    origin: 'https://cursor.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    referer: 'https://cursor.com/',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    priority: 'u=1, i',
    'user-agent': env.CURSOR_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'x-is-human': '',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(cursorReq),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Cursor API HTTP ${resp.status}: ${t.slice(0, 500)}`);
    }

    if (!resp.body) throw new Error('Cursor API no body');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const event = JSON.parse(data);
          if (event?.type === 'text-delta' && event?.delta) {
            onDelta(event.delta);
          }
        } catch (_) {
          // ignore non-json chunks
        }
      }
    }

    // process trailing buffer
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6).trim();
      if (data) {
        try {
          const event = JSON.parse(data);
          if (event?.type === 'text-delta' && event?.delta) {
            onDelta(event.delta);
          }
        } catch (_) {}
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function shortId() {
  return randomUUIDNoDash().slice(0, 16);
}

function randomId(prefix = '') {
  return prefix + randomUUIDNoDash().slice(0, 24);
}

function randomUUIDNoDash() {
  return crypto.randomUUID().replace(/-/g, '');
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

function json(obj, status = 200) {
  return withCors(new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function withCors(resp) {
  const h = new Headers(resp.headers);
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
