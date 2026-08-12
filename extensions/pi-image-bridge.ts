/**
 * pi-image-bridge — Vision bridge extension
 * (subagent routing removed; handled by native pi-subagents)
 *
 * When the main model does not support image input, automatically analyzes
 * images with the configured vision model and injects textual descriptions
 * into the context so the main model can "see" them. Covers two paths:
 *   1. Images attached to user input (input event)
 *   2. Images in tool results (tool_result event) — read, fetch_content,
 *      video frame extraction, etc. Any image in content is analyzed and
 *      replaced with a description.
 *
 * Features:
 *   - Model chain: tries fallbackModels in order when model fails
 *   - Per-image analysis: multi-image calls are labeled [Image N/M], no mixing
 *   - In-session cache: the same model+prompt+image combo is analyzed once
 *   - Cancel aware: wired to ctx.signal, Esc aborts vision calls immediately
 *   - Per-path prompts: input and tool_result can have separate prompts
 *   - Image size injection: description block includes WxH for layout awareness
 *   - Usage stats: cumulative calls / tokens / cost, /image-bridge stats
 *   - force mode: use vision assist even when the main model supports images
 *   - maxImages cap: prevents blowing up the context with too many images
 *
 * Config: ~/.pi/agent/pi-image-bridge.json (auto-created on first run)
 * Commands: /image-bridge           show current config
 *           /image-bridge toggle    toggle vision assist
 *           /image-bridge stats     show vision call stats for this session
 *           /image-bridge config    interactively edit the global config
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";

const CONFIG_FILENAME = "pi-image-bridge.json";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

type PromptKind = "input" | "toolResult";

interface VisionConfig {
	enabled?: boolean;
	model?: string;
	fallbackModels?: string[];
	/** string = shared by both paths; { input?, toolResult? } = per-path customization */
	prompt?: string | { input?: string; toolResult?: string };
	timeoutMs?: number;
	maxImages?: number;
	/** Force vision assist even when the main model supports images */
	force?: boolean;
	/** In-session cache, on by default */
	cache?: boolean;
}

interface AgentModelsConfig {
	vision?: VisionConfig;
}

// ---------------------------------------------------------------------------
// Default prompts (input and toolResult are separate)
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PROMPT = [
	"You are a vision assistant. The user attached an image to the main session, but the current model does not support image input.",
	"Describe the image content in detail and accurately: main subject, text (quote verbatim), layout, key details.",
	"Output plain description text only, no pleasantries, so the main model can understand the image from your description alone.",
].join("");

const DEFAULT_TOOL_PROMPT = [
	"You are a vision assistant. A tool result contains an image, but the current model does not support image input.",
	"Describe the image content in detail and accurately: main subject, text (quote verbatim), layout, key details.",
	"If it is a screenshot, transcribe the text verbatim; if it is a chart, read out the key numbers.",
	"Output plain description text only, no pleasantries, so the main model can understand the image from your description alone.",
].join("");

export function resolvePrompt(vision: VisionConfig, kind: PromptKind): string {
	const p = vision.prompt;
	if (typeof p === "string") {
		if (p.trim()) return p;
	} else if (p && typeof p === "object") {
		const specific = kind === "input" ? p.input : p.toolResult;
		if (typeof specific === "string" && specific.trim()) return specific;
	}
	return kind === "input" ? DEFAULT_INPUT_PROMPT : DEFAULT_TOOL_PROMPT;
}

// ---------------------------------------------------------------------------
// Config loading (re-read on every use, so edits take effect immediately)
// ---------------------------------------------------------------------------

function readJsonFile(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function writeJsonFile(file: string, data: unknown): void {
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function loadConfig(): AgentModelsConfig {
	return (readJsonFile(path.join(getAgentDir(), CONFIG_FILENAME)) ?? {}) as AgentModelsConfig;
}

// ---------------------------------------------------------------------------
// First-run bootstrap: create the global config file so users can find and
// edit their preferences. Never overwrites an existing file.
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AgentModelsConfig = {
	vision: {
		enabled: false,
		model: "",
		fallbackModels: [],
		timeoutMs: 30_000,
		maxImages: 4,
		force: false,
		cache: true,
	},
};

let configCreated = false;

function ensureDefaultConfig(): string | null {
	const file = path.join(getAgentDir(), CONFIG_FILENAME);
	if (fs.existsSync(file)) return null;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeJsonFile(file, DEFAULT_CONFIG);
		configCreated = true;
		return file;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Model reference resolution
// ---------------------------------------------------------------------------

function parseModelRef(ref: string): { provider?: string; modelId: string } {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) return { modelId: ref };
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** Resolve "provider/modelId" or a bare modelId (exact match on id or name); undefined when not found */
function resolveModel(ctx: ExtensionContext, ref: string) {
	const { provider, modelId } = parseModelRef(ref);
	if (provider) return ctx.modelRegistry.find(provider, modelId);
	return ctx.modelRegistry
		.getAll()
		.find((m) => m.id === modelId || m.name === modelId);
}

// ---------------------------------------------------------------------------
// One-time warnings
// ---------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(ctx: ExtensionContext, message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	ctx.ui.notify(message, "warning");
}

// ---------------------------------------------------------------------------
// Image utilities: hashing / dimensions / MIME sniffing / loading
// ---------------------------------------------------------------------------

export function hashImage(img: ImageContent): string {
	return createHash("sha1")
		.update(`${img.mimeType}:${img.data}`)
		.digest("hex")
		.slice(0, 16);
}

/** Parse dimensions from base64 image data (PNG / JPEG / GIF / WebP); null on failure */
export function parseImageSize(img: ImageContent): { width: number; height: number } | null {
	try {
		const buf = Buffer.from(img.data, "base64");
		if (buf.length < 8) return null;
		// PNG: width/height from IHDR
		if (buf.readUInt32BE(0) === 0x89504e47 && buf.length >= 24) {
			return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
		}
		// GIF
		if (buf.length >= 10 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) {
			return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
		}
		// WebP
		if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
			const vp8 = buf.toString("ascii", 12, 16);
			if (vp8 === "VP8 " && buf.length >= 30) {
				// Lossy: 14-bit width/height after the 3-byte frame tag
				return {
					width: buf.readUInt16LE(26) & 0x3fff,
					height: buf.readUInt16LE(28) & 0x3fff,
				};
			}
			if (vp8 === "VP8L" && buf.length >= 25) {
				const b = buf.readUInt32LE(21);
				return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
			}
		}
		// JPEG: scan for SOF markers
		if (buf[0] === 0xff && buf[1] === 0xd8) {
			let i = 2;
			while (i + 9 < buf.length) {
				if (buf[i] !== 0xff) {
					i++;
					continue;
				}
				const marker = buf[i + 1];
				if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
					i += 2;
					continue;
				}
				const len = buf.readUInt16BE(i + 2);
				const isSof =
					(marker >= 0xc0 && marker <= 0xc3) ||
					(marker >= 0xc5 && marker <= 0xc7) ||
					(marker >= 0xc9 && marker <= 0xcb) ||
					(marker >= 0xcd && marker <= 0xcf);
				if (isSof) {
					return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
				}
				i += 2 + len;
			}
		}
	} catch {
		// Ignore parse failures; size injection is optional
	}
	return null;
}

export function sniffMime(buf: Buffer): string {
	if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
	if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return "image/jpeg";
}

// ---------------------------------------------------------------------------
// Usage stats (accumulated within the session)
// ---------------------------------------------------------------------------

interface SessionStats {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

const stats: SessionStats = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

function accumulateUsage(usage?: Usage): void {
	if (!usage) return;
	stats.calls++;
	stats.inputTokens += usage.input ?? 0;
	stats.outputTokens += usage.output ?? 0;
	stats.cost += usage.cost?.total ?? 0;
}

export function mergeUsage(usages: Usage[]): Usage | undefined {
	if (usages.length === 0) return undefined;
	const sum = (f: (u: Usage) => number) => usages.reduce((acc, u) => acc + (f(u) ?? 0), 0);
	return {
		input: sum((u) => u.input),
		output: sum((u) => u.output),
		cacheRead: sum((u) => u.cacheRead),
		cacheWrite: sum((u) => u.cacheWrite),
		totalTokens: sum((u) => u.totalTokens),
		cost: {
			input: sum((u) => u.cost.input),
			output: sum((u) => u.cost.output),
			cacheRead: sum((u) => u.cost.cacheRead),
			cacheWrite: sum((u) => u.cost.cacheWrite),
			total: sum((u) => u.cost.total),
		},
	};
}

// ---------------------------------------------------------------------------
// Shared vision analysis logic (used by both input images and tool results)
// ---------------------------------------------------------------------------

const cache = new Map<string, string>(); // key -> description (in-session)

interface VisionOutcome {
	modelName: string;
	description: string;
	usage?: Usage;
	fromCache: boolean;
	failedCount: number;
	truncated: boolean;
	/** Analysis completed by a fallback model (not the configured primary) */
	usedFallback: boolean;
}

function isAbort(err: unknown): boolean {
	const e = err as { name?: string; message?: string };
	return (
		e?.name === "AbortError" ||
		e?.name === "TimeoutError" ||
		(e?.message ?? "").toLowerCase().includes("aborted")
	);
}

/**
 * Call the configured vision model (with fallback chain) per image and return
 * the joined description. Returns null on failure or when nothing is
 * configured; timeout/cancel are rethrown and handled by the caller.
 */
export async function runVisionAnalysis(
	ctx: ExtensionContext,
	images: ImageContent[],
	vision: VisionConfig,
	kind: PromptKind,
): Promise<VisionOutcome | null> {
	const prompt = resolvePrompt(vision, kind);
	const modelRefs = [vision.model, ...(vision.fallbackModels ?? [])].filter(
		(r): r is string => typeof r === "string" && r.length > 0,
	);
	if (modelRefs.length === 0) {
		warnOnce(
			ctx,
			"pi-image-bridge: vision.model not configured (see ~/.pi/agent/pi-image-bridge.json)",
		);
		return null;
	}

	const timeoutMs = vision.timeoutMs ?? 30_000;
	const maxImages = vision.maxImages ?? 4;
	const cacheEnabled = vision.cache !== false;
	const useImages = images.slice(0, maxImages);
	const truncated = images.length > maxImages;

	// The cache key uses the first resolvable model ref so it doesn't drift
	// after fallbacks. On cache hit the model name resolves from primaryRef
	// (real calls use target.name).
	const primaryRef = modelRefs.find((ref) => resolveModel(ctx, ref)) ?? modelRefs[0];
	const primaryTarget = resolveModel(ctx, primaryRef);

	const parts: string[] = [];
	const usages: Usage[] = [];
	let primaryName: string | undefined;
	let fromCache = false;
	let failedCount = 0;
	let usedFallback = false;

	for (let i = 0; i < useImages.length; i++) {
		const img = useImages[i];
		const multi = useImages.length > 1;
		const size = parseImageSize(img);
		const header = multi
			? `[Image ${i + 1}/${useImages.length}${size ? `, ${size.width}×${size.height}` : ""}]`
			: `[Image${size ? `, ${size.width}×${size.height}` : ""}]`;

		// In-session cache
		if (cacheEnabled) {
			const key = `${primaryRef}|${prompt}|${hashImage(img)}`;
			const cached = cache.get(key);
			if (cached) {
				parts.push(`${header}\n${cached}`);
				fromCache = true;
				primaryName = primaryName ?? primaryTarget?.name;
				continue;
			}
		}

		const perImagePrompt = multi
			? `${prompt}\n\nThis is image ${i + 1} of ${useImages.length}. Describe this image independently, in order.`
			: prompt;

		let success = false;
		// The configured primary model ref (first); if another model succeeds → usedFallback
		const primaryModelRef = modelRefs[0];
		for (const ref of modelRefs) {
			const target = resolveModel(ctx, ref);
			if (!target) {
				warnOnce(ctx, `pi-image-bridge: vision model "${ref}" not found, check your config`);
				continue;
			}
			ctx.ui.setStatus(
				"pi-image-bridge",
				`🔍 Vision: ${target.name} analyzing ${useImages.length} image(s) (${i + 1}/${useImages.length})…`,
			);
			try {
				const signal = ctx.signal
					? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
					: AbortSignal.timeout(timeoutMs);
				const result = await ctx.modelRegistry.complete(
					target,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: perImagePrompt }, img],
								timestamp: Date.now(),
							},
						],
					},
					{ signal },
				);
				const description = result.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				if (!description) {
					failedCount++;
					success = true; // Called but returned no content; don't burn more fallbacks
					break;
				}
				primaryName = primaryName ?? target.name;
				if (ref !== primaryModelRef) usedFallback = true;
				parts.push(`${header}\n${description}`);
				if (result.usage) {
					usages.push(result.usage);
					accumulateUsage(result.usage);
				}
				if (cacheEnabled) cache.set(`${primaryRef}|${prompt}|${hashImage(img)}`, description);
				success = true;
				break;
			} catch (err) {
				if (isAbort(err)) throw err; // Timeout/cancel: stop the whole batch
				ctx.ui.notify(`Vision assist (${target.name}) failed: ${(err as Error).message ?? String(err)}`, "error");
				// Other errors: try the next fallback
			}
		}
		if (!success) failedCount++;
	}

	ctx.ui.setStatus("pi-image-bridge", undefined);

	if (parts.length === 0) return null;

	let description = parts.join("\n\n");
	if (truncated) description += `\n\n(${images.length} image(s) total; only the first ${maxImages} were analyzed — adjust vision.maxImages)`;
	if (failedCount > 0) description += `\n\n(${failedCount} image(s) failed to analyze)`;

	return {
		modelName: primaryName ?? "unknown",
		description,
		usage: mergeUsage(usages),
		fromCache,
		failedCount,
		truncated,
		usedFallback,
	};
}

/** Safe wrapper for runVisionAnalysis: converts failures/aborts into notifications */
async function analyzeSafely(
	ctx: ExtensionContext,
	images: ImageContent[],
	vision: VisionConfig,
	kind: PromptKind,
): Promise<VisionOutcome | null> {
	try {
		return await runVisionAnalysis(ctx, images, vision, kind);
	} catch (err) {
		if (isAbort(err)) {
			ctx.ui.notify("Vision analysis aborted (timeout or cancelled)", "warning");
		} else {
			ctx.ui.notify(`Vision analysis failed: ${(err as Error).message ?? String(err)}`, "error");
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

const SUBCOMMANDS = ["toggle", "config", "stats"] as const;

function formatConfig(vision: VisionConfig | undefined): string {
	const lines: string[] = [];
	lines.push("── Vision assist ──");
	if (!vision) {
		lines.push("(not configured)");
		return lines.join("\n");
	}
	if (!vision.enabled) {
		lines.push("disabled");
		return lines.join("\n");
	}
	lines.push(`model: ${vision.model ?? "not set"}${(vision.fallbackModels?.length ?? 0) > 0 ? ` + ${vision.fallbackModels!.length} fallback(s)` : ""}`);
	lines.push(`prompt: ${typeof vision.prompt === "string" ? "custom (shared)" : vision.prompt ? "custom (per-path)" : "default"}`);
	lines.push(`timeoutMs: ${vision.timeoutMs ?? 30000}`);
	lines.push(`maxImages: ${vision.maxImages ?? 4}`);
	lines.push(`force: ${vision.force ?? false}`);
	lines.push(`cache: ${vision.cache ?? true}`);
	return lines.join("\n");
}

/** Toggle vision assist in the global config */
function toggleEnabled(ctx: ExtensionContext): boolean {
	const file = path.join(getAgentDir(), CONFIG_FILENAME);
	const config = (readJsonFile(file) ?? {}) as AgentModelsConfig;
	const current = config.vision?.enabled ?? false;
	const next = !current;
	config.vision = { ...(config.vision ?? {}), enabled: next };
	writeJsonFile(file, config);
	ctx.ui.notify(`pi-image-bridge: vision assist ${next ? "enabled" : "disabled"} (global config)`, "info");
	return next;
}

function cmdStats(ctx: ExtensionContext): void {
	ctx.ui.notify(
		`pi-image-bridge session stats:\nvision calls: ${stats.calls}\ninput tokens: ${stats.inputTokens}\noutput tokens: ${stats.outputTokens}\ntotal cost: $${stats.cost.toFixed(4)}`,
		"info",
	);
}

/** Model label for notifications: marks when a fallback model was used */
function modelBadge(result: VisionOutcome): string {
	return result.usedFallback
		? `${result.modelName} (fallback)`
		: result.modelName;
}

/** Interactively edit the global config, one field per round; exit via Esc or "Done" */
async function cmdConfig(ctx: ExtensionContext): Promise<void> {
	const file = path.join(getAgentDir(), CONFIG_FILENAME);
	const config = (readJsonFile(file) ?? {}) as AgentModelsConfig;
	config.vision = config.vision ?? {};

	let done = false;
	while (!done) {
		const v = config.vision!;
		const fields = [
			`enabled (current: ${v.enabled ?? false})`,
			`model (current: ${v.model ?? "not set"})`,
			`fallbackModels (current: ${(v.fallbackModels ?? []).join(", ") || "not set"})`,
			`timeoutMs (current: ${v.timeoutMs ?? 30000})`,
			`maxImages (current: ${v.maxImages ?? 4})`,
			`force (current: ${v.force ?? false})`,
			`cache (current: ${v.cache ?? true})`,
			"Done",
		];
		const choice = await ctx.ui.select("Edit field (Esc to finish)", fields);
		if (!choice) break;

		const field = choice.split(" (")[0];
		const input = async (title: string, current: string) => {
			const val = await ctx.ui.input(title, current);
			return val === undefined ? undefined : val.trim();
		};

		if (field === "Done") {
			done = true;
			break;
		}
		if (field === "model") {
			const val = await input("Vision model ref (e.g. opencode-go/gpt-5.6-luna, empty to clear)", v.model ?? "");
			if (val !== undefined) {
				if (val) v.model = val;
				else delete v.model;
			}
		} else if (field === "fallbackModels") {
			const val = await input("Fallback model ref (e.g. opencode-go/qwen3.7-plus, empty to clear)", v.fallbackModels?.[0] ?? "");
			if (val !== undefined) {
				if (val.trim()) v.fallbackModels = [val.trim()];
				else delete v.fallbackModels;
			}
		} else if (field === "enabled" || field === "force" || field === "cache") {
			const defaultVal = field === "cache"; // cache on, enabled/force off by default
			const val = await input(`${field} (true/false)`, String(v[field] ?? defaultVal));
			if (val !== undefined) {
				if (val === "true") v[field] = true;
				else if (val === "false") v[field] = false;
			}
		} else if (field === "timeoutMs" || field === "maxImages") {
			const val = await input(`${field} (number)`, String(v[field] ?? (field === "timeoutMs" ? 30000 : 4)));
			if (val !== undefined) {
				const num = Number(val);
				if (Number.isFinite(num) && num > 0) v[field] = Math.floor(num);
			}
		}
		writeJsonFile(file, config);
	}
	ctx.ui.notify(`Config saved to ${file}`, "info");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// ---- 0. First-run bootstrap: create the default config file ----
	const createdConfig = ensureDefaultConfig();

	pi.on("session_start", async (_event, ctx) => {
		if (createdConfig) {
			ctx.ui.notify(
				`pi-image-bridge: no config found — created a default one at ${createdConfig}. Vision assist is off by default; set enabled to true and configure vision.model to activate it.`,
				"info",
			);
		}
	});

	// ---- 1. Vision assist: user input with images ----
	pi.on("input", async (event, ctx) => {
		const images = event.images;
		if (!images || images.length === 0) return { action: "continue" };

		const config = loadConfig();
		const vision = config.vision;
		if (!vision || !vision.enabled) return { action: "continue" };

		// Main model accepts images and force is off → no assist needed
		const mainModel = ctx.model;
		if (!vision.force && mainModel && mainModel.input.includes("image")) return { action: "continue" };

		const result = await analyzeSafely(ctx, images, vision, "input");
		if (!result) return { action: "continue" };

		ctx.ui.notify(
			`Vision: ${modelBadge(result)} analyzed ${images.length} image(s)${result.fromCache ? " (cached)" : ""}`,
			"info",
		);
		return {
			action: "transform",
			text: `${event.text}\n\n[📷 Vision (${result.modelName}): description of ${images.length} image(s)]\n${result.description}`,
			images: [],
		};
	});

	// ---- 2. Vision assist: images in tool results (read / fetch_content /
	//        video frames, etc.) ----
	// Not filtered by tool name: any image in tool_result content is handled,
	// which covers read / fetch_content (even with renamed toolNames) and
	// future tools.
	pi.on("tool_result", async (event, ctx) => {
		const images = event.content.filter((c): c is ImageContent => c.type === "image");
		if (images.length === 0) return;

		const config = loadConfig();
		const vision = config.vision;
		if (!vision || !vision.enabled) return;

		// Main model accepts images and force is off → no assist needed
		const mainModel = ctx.model;
		if (!vision.force && mainModel && mainModel.input.includes("image")) return;

		const result = await analyzeSafely(ctx, images, vision, "toolResult");
		if (!result) return;

		ctx.ui.notify(
			`Vision: ${modelBadge(result)} analyzed ${images.length} image(s)${result.fromCache ? " (cached)" : ""}`,
			"info",
		);

		// Replace images with placeholder text (the main model can't take
		// images; passing them through would silently drop them)
		let imgIdx = 0;
		const newContent: (TextContent | ImageContent)[] = event.content.map((c) => {
			if (c.type !== "image") return c;
			imgIdx++;
			const multi = images.length > 1;
			return {
				type: "text" as const,
				text: multi ? `[Image ${imgIdx} content described above]` : "[Image content described above]",
			};
		});
		const descBlock: TextContent = {
			type: "text",
			text: `[📷 Vision (${result.modelName}): description of ${images.length} image(s)]\n${result.description}`,
		};
		return {
			content: [descBlock, ...newContent],
			usage: result.usage,
		};
	});

	// ---- 3. Commands ----
	pi.registerCommand("image-bridge", {
		description: "Vision assist: show config / toggle / stats / edit config",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();
			if (trimmed.includes(" ")) return null; // No completion for subcommand args
			const items = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(trimmed));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";

			switch (sub) {
				case "":
					ctx.ui.notify(
						`${formatConfig(loadConfig().vision)}\nconfig file: ${path.join(getAgentDir(), CONFIG_FILENAME)}`,
						"info",
					);
					break;
				case "toggle":
					toggleEnabled(ctx);
					break;
				case "stats":
					cmdStats(ctx);
					break;
				case "config":
					await cmdConfig(ctx);
					break;
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Available: ${SUBCOMMANDS.join(" / ")}`, "warning");
			}
		},
	});
}
