# cursor2api Worker 版（Cloudflare Workers）

这是 `7836246/cursor2api` 的 Cloudflare Worker 运行时最小可用改造。

## 目标

- 支持 Anthropic Messages API:
  - `POST /v1/messages`
  - `POST /messages`
- 支持 OpenAI Chat Completions API:
  - `POST /v1/chat/completions`
  - `POST /chat/completions`
- 支持:
  - `GET /v1/models`
  - `GET /health`

## 当前实现特性

- ✅ 流式 / 非流式 都支持
- ✅ CORS 支持
- ✅ 直接请求 `https://cursor.com/api/chat` 并解析 SSE `text-delta`
- ✅ 纯 Worker runtime（无 Node fs/process 依赖）

## 当前限制（相对主项目）

- ❌ 未移植原项目的拒绝检测/自动重试清洗策略
- ❌ 未移植 vision / OCR 模块
- ❌ 未完整移植 tool_call 解析闭环（当前走文本直通）
- ❌ 未移植 yaml/config 文件系统加载（改为 Worker vars）

## 部署

```bash
cd worker
npm i -D wrangler
npx wrangler login
npx wrangler deploy
```

## 环境变量（wrangler.toml [vars]）

- `CURSOR_MODEL` 默认: `anthropic/claude-sonnet-4.6`
- `CURSOR_CHAT_API` 默认: `https://cursor.com/api/chat`
- `CURSOR_TIMEOUT_MS` 默认: `120000`
- `CURSOR_USER_AGENT` 默认 Chrome 140 UA

## 风险提示（技术层面）

Cloudflare Worker 出口 IP 为 Cloudflare 机房共享 IP，可能被目标站风控/限流；可考虑后续改为 Worker 只做协议转换，真正上游请求走你自有 VPS 出口。
