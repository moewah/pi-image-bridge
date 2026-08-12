# pi-image-bridge

Vision bridge for [pi](https://pi.dev): when the main model does not support image input, pi-image-bridge automatically analyzes images with a configurable vision model and injects textual descriptions into the context, so the main model can "see" them.

## How it works

It covers the two paths through which images enter the context:

1. **User input with images** (`input` event) — when the user drags an image into the input box, it is analyzed and the description is injected.
2. **Images in tool results** (`tool_result` event) — `read` of image files, `fetch_content` screenshots, video frame extraction, etc. Any image in a tool result is analyzed and replaced with a description.

> Not filtered by tool name: any image in a tool result is handled, so `fetch_content` keeps working even if its tool name is renamed via `toolNames`.

When the main model already supports images, the bridge is skipped automatically (use `force` to override).

## Features

- **Model chain**: on failure (auth errors, rate limits, 5xx), tries `fallbackModels` in order. Timeout or user cancel stops the whole batch — no more burning fallbacks.
- **Per-image analysis**: multiple images are analyzed separately and labeled `[Image N/M]`; each call gets an independent "image N of M" instruction.
- **In-session cache**: the same `model + prompt + image` combo is analyzed only once; repeat hits return instantly, saving time and money (see `/image-bridge stats` for real call counts).
- **Cancel aware**: wired to `ctx.signal`, so pressing Esc aborts vision calls immediately without wasting quota.
- **Per-path prompts**: `prompt` can be a `{ input, toolResult }` object to customize analysis instructions per path.
- **Image size injection**: the description block carries `WxH` dimensions (PNG/JPEG/GIF/WebP), giving the main model layout awareness for banners, screenshots, and tall images.
- **Usage stats**: session-cumulative vision call count, tokens, and cost.
- **maxImages cap**: prevents a pile of images from blowing up the vision
  model's context (default 4; excess is truncated and reported).

## Install

```bash
pi install npm:@moewah-dev/pi-image-bridge
```

For development, load it directly:

```bash
pi -e ./extensions/pi-image-bridge.ts
```

## Configuration

pi-image-bridge is **global by design**: there is one and only one config file, `~/.pi/agent/pi-image-bridge.json`, shared across all projects — no per-project config. If a particular project doesn't need vision assist, turn it off temporarily with `/image-bridge toggle` (a global switch; toggle it back on when needed).

On first run the extension **automatically creates** a default config file at `~/.pi/agent/pi-image-bridge.json`, so you can find and edit your preferences right away. It never overwrites an existing file. Vision assist is **off by default**: set `enabled` to `true` and configure `vision.model` to activate it.

```json
{
  "vision": {
    "enabled": true,
    "model": "opencode-go/gpt-5.6-luna",
    "fallbackModels": ["opencode-go/qwen3.7-plus"],
    "prompt": {
      "input": "Custom instructions for input images...",
      "toolResult": "Custom instructions for tool-result images..."
    },
    "timeoutMs": 30000,
    "maxImages": 4,
    "force": false,
    "cache": true
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch (off by default) |
| `model` | *(empty)* | Primary vision model ref (`provider/modelId`, must be registered/authenticated) |
| `fallbackModels` | `[]` | Fallback chain, tried in order when the primary fails |
| `prompt` | built-in | `string` shared by both paths, or `{ input?, toolResult? }` per path |
| `timeoutMs` | `30000` | Per-call timeout in ms; timeout stops the whole batch |
| `maxImages` | `4` | Max images analyzed per batch; excess is truncated |
| `force` | `false` | Use vision assist even when the main model supports images |
| `cache` | `true` | In-session cache keyed by model + prompt + image |

Model ref format: `provider/modelId` (e.g. `opencode-go/gpt-5.6-luna`), or a bare `modelId` (exact match on `id`/`name` among registered models).

> If you subscribe to [OpenCode Go](https://opencode.ai/go?ref=WAQ03GAAVM), you get access to quite a few vision-capable models. For a vision model, being cheap and easy to use is what matters most — under the OpenCode Go plan, `opencode-go/gpt-5.6-luna` and `opencode-go/qwen3.7-plus` are both solid choices.

## Commands

| Command | Description |
|---------|-------------|
| `/image-bridge` | Show the current config and its config file path |
| `/image-bridge toggle` | Toggle vision assist in the global config |
| `/image-bridge stats` | Show vision calls, tokens, and total cost for this session |
| `/image-bridge config` | Interactively edit the global config (select + input) |

Subcommands support Tab completion.

## Files

- `extensions/pi-image-bridge.ts` — the extension itself
- `~/.pi/agent/pi-image-bridge.json` — config (auto-created on first run)
