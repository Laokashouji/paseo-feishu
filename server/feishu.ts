/**
 * paseo-feishu 服务端。
 *
 * 唯一外部依赖为飞书 / Lark 官方开源 CLI `lark-cli`（@larksuite/cli），
 * 插件自身不保存任何凭证，直接复用本机已登录态。
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { URL } from "node:url";

// ============ 跨平台基础设施 ============

export type LarkBrand = "feishu" | "lark";

const APPLINK_ORIGIN: Record<LarkBrand, string> = {
  feishu: "https://applink.feishu.cn",
  lark: "https://applink.larksuite.com",
};

function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 插件状态目录（ui-state、settings、最近附加记录）。 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = (env.PASEO_FEISHU_DIR || env.FEISHU_PLUGIN_DIR)?.trim();
  if (explicit) return resolve(explicit);
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) return resolve(appData, "paseo-feishu");
  } else {
    const xdg = env.XDG_CONFIG_HOME?.trim();
    if (xdg) return resolve(xdg, "paseo-feishu");
  }
  const home = userHome(env);
  if (home) return resolve(home, ".config", "paseo-feishu");
  return resolve(tmpdir(), "paseo-feishu");
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

function listNvmBins(home: string, binName: string): string[] {
  const versionsDir = resolve(home, ".nvm", "versions", "node");
  if (!existsSync(versionsDir)) return [];
  try {
    return readdirSync(versionsDir)
      .sort(compareVersionDesc)
      .map((ver) => resolve(versionsDir, ver, "bin", binName));
  } catch {
    return [];
  }
}

/**
 * 跨平台解析 lark-cli 可执行文件路径。
 *
 * 插件后端由 Paseo daemon 拉起，macOS（launchd / 桌面端）或 Linux（systemd）下
 * PATH 常为精简值，未必包含 Homebrew / pnpm / nvm / Volta 等目录，
 * 因此优先读取显式环境变量，其次查 PATH，再按常见安装路径探测。
 */
export function resolveLarkCliBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const fromEnv = (env.FEISHU_LARK_CLI_BIN || env.LARK_CLI_BIN)?.trim();
  if (fromEnv) return fromEnv;

  const isWin = platform === "win32";
  const pathSep = isWin ? ";" : ":";
  const names = isWin ? ["lark-cli.exe", "lark-cli.cmd"] : ["lark-cli"];

  // 1. 优先尊重当前 PATH 里已有的安装
  const rawPath = env.PATH ?? env.Path ?? "";
  for (const dir of rawPath.split(pathSep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = resolve(trimmed, name);
      if (isFile(candidate)) return candidate;
    }
  }

  // 2. 常见包管理器与系统安装位置（兼容 macOS Apple Silicon/Intel、Linux、Windows）
  const home = userHome(env);
  const candidates: string[] = [];
  if (isWin) {
    const localAppData = env.LOCALAPPDATA?.trim();
    const appData = env.APPDATA?.trim();
    if (appData) {
      candidates.push(
        resolve(appData, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
        resolve(appData, "npm", "lark-cli.cmd"),
      );
    }
    if (localAppData) {
      candidates.push(
        resolve(localAppData, "pnpm", "lark-cli.exe"),
        resolve(localAppData, "pnpm", "lark-cli.cmd"),
      );
    }
    candidates.push(
      resolve(home, ".volta", "bin", "lark-cli.exe"),
      resolve(home, ".volta", "bin", "lark-cli.cmd"),
      resolve(home, "scoop", "shims", "lark-cli.exe"),
      resolve(home, "scoop", "shims", "lark-cli.cmd"),
      resolve(home, "go", "bin", "lark-cli.exe"),
    );
  } else {
    candidates.push(
      // macOS pnpm 默认全局目录
      resolve(home, "Library", "pnpm", "lark-cli"),
      // Linux pnpm 全局目录
      resolve(home, ".local", "share", "pnpm", "lark-cli"),
      resolve(home, ".local", "share", "pnpm", "bin", "lark-cli"),
      // Homebrew（Apple Silicon / Intel）与标准系统目录
      "/opt/homebrew/bin/lark-cli",
      "/usr/local/bin/lark-cli",
      // 常见用户级与版本管理器目录
      resolve(home, ".local", "bin", "lark-cli"),
      resolve(home, ".volta", "bin", "lark-cli"),
      resolve(home, ".bun", "bin", "lark-cli"),
      resolve(home, ".npm-global", "bin", "lark-cli"),
      resolve(home, ".asdf", "shims", "lark-cli"),
      resolve(home, ".local", "share", "mise", "shims", "lark-cli"),
      resolve(home, ".local", "share", "fnm", "aliases", "default", "bin", "lark-cli"),
      resolve(home, "Library", "Application Support", "fnm", "aliases", "default", "bin", "lark-cli"),
      resolve(home, ".nvm", "current", "bin", "lark-cli"),
      ...listNvmBins(home, "lark-cli"),
      resolve(home, "go", "bin", "lark-cli"),
    );
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return "lark-cli";
}

/**
 * 为子进程补全 PATH。
 *
 * `@larksuite/cli` 的 npm/pnpm 入口脚本使用 `#!/usr/bin/env node`；
 * 在 macOS 桌面端或 launchd 的极简 PATH 下若不补上当前 Node 目录，执行会报 `env: node: No such file or directory`。
 */
export function buildChildPath(
  bin: string,
  currentPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): string {
  const sep = platform === "win32" ? ";" : ":";
  const entries: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string | undefined) => {
    const trimmed = dir?.trim();
    if (!trimmed) return;
    const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(trimmed);
  };

  for (const dir of (currentPath ?? "").split(sep)) push(dir);
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) push(dirname(bin));
  if (execPath) push(dirname(execPath));
  if (platform === "darwin") {
    push("/opt/homebrew/bin");
    push("/usr/local/bin");
  }
  return entries.join(sep);
}

/** 解析 Windows `.cmd` 包装器背后的原生可执行文件或 Node 脚本，避免 shell 注入。 */
function resolveSpawnTarget(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const dir = dirname(bin);
    const nativeExe = resolve(dir, "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe");
    if (isFile(nativeExe)) return { file: nativeExe, args, shell: false };
    const jsEntry = resolve(dir, "node_modules", "@larksuite", "cli", "scripts", "run.js");
    if (isFile(jsEntry)) return { file: process.execPath, args: [jsEntry, ...args], shell: false };
    return { file: bin, args, shell: true };
  }
  return { file: bin, args, shell: false };
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** 默认 30s。 */
  timeoutMs?: number;
}

function runCli(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const target = resolveSpawnTarget(bin, args);
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  mergedEnv.PATH = buildChildPath(target.file, mergedEnv.PATH ?? mergedEnv.Path);
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      target.file,
      target.args,
      {
        env: mergedEnv,
        shell: target.shell,
        maxBuffer: 16 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).trim().slice(0, 400);
          reject(new Error(`${bin} ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function runJson<T>(bin: string, args: string[], opts: RunOptions = {}): Promise<T> {
  const stdout = await runCli(bin, args, opts);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${bin} ${args.join(" ")} returned non-JSON output`);
  }
}

export const larkCli = <T>(args: string[], opts?: RunOptions) =>
  runJson<T>(resolveLarkCliBin(), args, opts);

/** 把任意异常转成一句可展示的话。 */
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("ENOENT")) {
    return "找不到 lark-cli，请先安装 @larksuite/cli 并完成登录，或通过 FEISHU_LARK_CLI_BIN 指定路径";
  }
  return raw.slice(0, 300);
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// ============ 飞书 / Lark 域名识别 ============

function normalizeBrand(value: unknown): LarkBrand | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "lark" || v === "larksuite") return "lark";
  if (v === "feishu") return "feishu";
  return undefined;
}

function readBrandFromLarkCliConfig(env: NodeJS.ProcessEnv = process.env): LarkBrand | undefined {
  const configDir =
    env.LARKSUITE_CLI_CONFIG_DIR?.trim() || resolve(userHome(env), ".lark-cli");
  const configPath = resolve(configDir, "config.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const cfg = parsed as Record<string, unknown>;
    const top = normalizeBrand(cfg.brand);
    if (top) return top;
    if (Array.isArray(cfg.apps) && cfg.apps.length > 0) {
      const preferredId =
        typeof cfg.activeAppId === "string"
          ? cfg.activeAppId
          : typeof cfg.defaultAppId === "string"
            ? cfg.defaultAppId
            : typeof cfg.appId === "string"
              ? cfg.appId
              : typeof cfg.profile === "string"
                ? cfg.profile
                : undefined;
      const apps = cfg.apps.filter(
        (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
      );
      const matched = preferredId
        ? apps.find((app) => app.appId === preferredId || app.name === preferredId)
        : undefined;
      return normalizeBrand((matched ?? apps[0])?.brand);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function inferBrandFromLinks(links: Array<string | undefined>): LarkBrand | undefined {
  for (const link of links) {
    if (!link || !URL.canParse(link)) continue;
    const host = new URL(link).hostname.toLowerCase();
    if (host.endsWith("larksuite.com")) return "lark";
    if (host.endsWith("feishu.cn")) return "feishu";
  }
  return undefined;
}

export function resolveLarkBrand(
  sampleLinks: Array<string | undefined> = [],
  env: NodeJS.ProcessEnv = process.env,
): LarkBrand {
  return (
    normalizeBrand(env.FEISHU_BRAND ?? env.LARK_BRAND) ??
    readBrandFromLarkCliConfig(env) ??
    inferBrandFromLinks(sampleLinks) ??
    "feishu"
  );
}

export function fallbackChatAppLink(chatId: string, brand: LarkBrand): string {
  return `${APPLINK_ORIGIN[brand]}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

// ============ 最近附加记录 ============

function attachLogPath(): string {
  return resolve(resolveStateDir(), "recent-attach.json");
}

function readAttachLog(): Record<string, string> {
  const path = attachLogPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function handleRecordAttach({ chatId }: { chatId: string }) {
  try {
    const log = readAttachLog();
    log[chatId] = new Date().toISOString();
    // 只留最近 50 条，避免无限增长。
    const trimmed = Object.entries(log)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 50);
    const path = attachLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeAtomic(path, JSON.stringify(Object.fromEntries(trimmed), null, 2));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ============ 飞书 / Lark 原生：会话 ============

interface ChatRaw {
  chat_id?: string;
  name?: string;
  chat_mode?: string;
  p2p_target_type?: string;
  external?: boolean;
  chat_app_link?: string;
}

/**
 * 拉一页会话。真分页避免一次拉全量拖慢首屏。
 */
async function fetchChatPage(
  pageSize: number,
  pageToken?: string,
): Promise<{ chats: ChatRaw[]; hasMore: boolean; nextPageToken?: string }> {
  const args = [
    "im",
    "+chat-list",
    "--types",
    "p2p,group",
    "--sort",
    "active_time",
    "--page-size",
    String(Math.min(100, Math.max(1, pageSize))),
  ];
  if (pageToken) args.push("--page-token", pageToken);

  const d = await larkCli<{
    ok?: boolean;
    data?: { chats?: ChatRaw[]; has_more?: boolean; page_token?: string };
  }>(args, { timeoutMs: 30_000 });
  if (d.ok === false || !Array.isArray(d.data?.chats)) throw new Error("会话列表读取失败");

  return {
    chats: d.data?.chats ?? [],
    hasMore: d.data?.has_more ?? false,
    nextPageToken: d.data?.page_token,
  };
}

export async function handleListChats({
  pageSize,
  pageToken,
}: {
  pageSize?: number;
  pageToken?: string;
}) {
  const attachLog = readAttachLog();
  const page = await fetchChatPage(pageSize ?? 20, pageToken);

  const chats = page.chats
    .filter((c) => c.chat_id)
    .map((c) => ({
      id: c.chat_id!,
      name: c.name || "(未命名会话)",
      mode: c.chat_mode ?? "unknown",
      targetType: c.p2p_target_type,
      external: c.external,
      appLink: c.chat_app_link,
      lastAttachedAt: attachLog[c.chat_id!],
    }));

  // 只在第一页做「最近附加过优先」的重排，避免翻页后已加载条目跳动。
  if (!pageToken) {
    const attached = chats.filter((c) => c.lastAttachedAt);
    const rest = chats.filter((c) => !c.lastAttachedAt);
    attached.sort((a, b) => (b.lastAttachedAt ?? "").localeCompare(a.lastAttachedAt ?? ""));
    return {
      chats: [...attached, ...rest],
      hasMore: page.hasMore,
      nextPageToken: page.nextPageToken,
    };
  }

  return { chats, hasMore: page.hasMore, nextPageToken: page.nextPageToken };
}

/**
 * 搜索会话。
 *
 * `im +chat-search` 只覆盖群聊和话题群，搜不到 p2p 单聊，因此两条路合并：
 *   1. 服务端搜群
 *   2. 本地分页过滤单聊
 */
export async function handleSearchChats({ query }: { query: string }) {
  const q = query.trim();
  if (!q) return { chats: [], scope: "local" as const };

  const attachLog = readAttachLog();
  const seen = new Set<string>();
  const out: ReturnType<typeof mapChat>[] = [];

  function mapChat(c: ChatRaw) {
    return {
      id: c.chat_id!,
      name: c.name || "(未命名会话)",
      mode: c.chat_mode ?? "unknown",
      targetType: c.p2p_target_type,
      external: c.external,
      appLink: c.chat_app_link,
      lastAttachedAt: attachLog[c.chat_id!],
    };
  }

  let serverOk = false;
  let serverError: unknown;
  try {
    const d = await larkCli<{ data?: { chats?: ChatRaw[] } }>(
      ["im", "+chat-search", "--query", q, "--page-size", "50"],
      { timeoutMs: 30_000 },
    );
    for (const c of d.data?.chats ?? []) {
      if (!c.chat_id || seen.has(c.chat_id)) continue;
      seen.add(c.chat_id);
      out.push(mapChat(c));
    }
    serverOk = true;
  } catch (error) {
    serverError = error;
  }

  let localHit = 0;
  let localOk = false;
  const needLocal = out.length < 20;
  try {
    if (!needLocal) throw new Error("skip");
    const lower = q.toLowerCase();
    let token: string | undefined;
    for (let i = 0; i < 2; i++) {
      const page = await fetchChatPage(100, token);
      localOk = true;
      for (const c of page.chats) {
        if (!c.chat_id || seen.has(c.chat_id)) continue;
        if (c.chat_mode !== "p2p") continue;
        if (!(c.name ?? "").toLowerCase().includes(lower)) continue;
        seen.add(c.chat_id);
        out.push(mapChat(c));
        localHit++;
      }
      if (!page.hasMore || !page.nextPageToken) break;
      token = page.nextPageToken;
    }
  } catch {
    // 本地补充失败不影响服务端结果
  }

  const scope = serverOk && localHit > 0 ? "mixed" : serverOk ? "server" : "local";
  return {
    chats: out.slice(0, 60),
    scope: scope as "server" | "local" | "mixed",
    error: !serverOk && !localOk ? errText(serverError) : undefined,
  };
}

// ============ 飞书 / Lark 原生：待办 ============

interface TaskRaw {
  guid?: string;
  summary?: string;
  due_at?: string;
  created_at?: string;
  url?: string;
  completed?: boolean;
}

export async function handleListTasks({ completed }: { completed?: boolean }) {
  try {
    const args = ["task", "+get-my-tasks", "--page-limit", "20"];
    if (completed !== undefined) args.push(`--complete=${completed}`);
    const d = await larkCli<{ data?: { items?: TaskRaw[] } }>(args, { timeoutMs: 60_000 });
    const now = Date.now();
    return {
      available: true,
      tasks: (d.data?.items ?? [])
        .filter((t) => t.guid)
        .map((t) => ({
          guid: t.guid!,
          summary: t.summary ?? "(无标题)",
          dueAt: t.due_at,
          createdAt: t.created_at,
          url: t.url,
          overdue: t.due_at ? new Date(t.due_at).getTime() < now : false,
        }))
        .sort((a, b) => {
          if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
          if (a.dueAt) return -1;
          if (b.dueAt) return 1;
          return 0;
        }),
    };
  } catch (err) {
    return { available: false, error: errText(err), tasks: [] };
  }
}

// ============ 飞书 / Lark 原生：日程 ============

interface EventRaw {
  event_id?: string;
  summary?: string;
  start_time?: { datetime?: string; date?: string; timezone?: string };
  end_time?: { datetime?: string; date?: string; timezone?: string };
  location?: { name?: string };
  vchat?: { meeting_url?: string; vc_type?: string };
  app_link?: string;
}

export async function handleGetAgenda({ start, end }: { start?: string; end?: string }) {
  try {
    const args = ["calendar", "+agenda"];
    if (start) args.push("--start", start);
    if (end) args.push("--end", end);
    const d = await larkCli<{ data?: EventRaw[] }>(args, { timeoutMs: 60_000 });
    return {
      available: true,
      events: (d.data ?? [])
        .filter((e) => e.event_id)
        .map((e) => ({
          id: e.event_id!,
          summary: e.summary ?? "(无标题)",
          start: e.start_time?.datetime ?? e.start_time?.date,
          end: e.end_time?.datetime ?? e.end_time?.date,
          allDay: !e.start_time?.datetime && !!e.start_time?.date,
          location: e.location?.name,
          isVc: !!e.vchat?.meeting_url,
        }))
        .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "")),
    };
  } catch (err) {
    return { available: false, error: errText(err), events: [] };
  }
}

// ============ 附件源 ============

/**
 * 附件内容仅给「定位参数 + 查询命令」，不内联大量消息正文。
 */
function chatAttachText(c: {
  id: string;
  name: string;
  mode: string;
  targetType?: string;
  appLink?: string;
}): string {
  const kind = c.mode === "p2p" ? (c.targetType === "bot" ? "单聊（机器人）" : "单聊") : "群聊";
  const lines = [
    `# 飞书会话：${c.name}`,
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    `| chat id | \`${c.id}\` |`,
    `| 类型 | ${kind} |`,
  ];
  if (c.appLink) lines.push(`| 打开 | ${c.appLink} |`);
  lines.push(
    "",
    "## 查询方式",
    "",
    "```bash",
    "# 读最近消息",
    `lark-cli im +chat-messages-list --chat-id ${c.id} --page-size 50`,
    "",
    "# 在这个会话里搜索",
    `lark-cli im +messages-search --query "<关键词>" --chat-id ${c.id}`,
    "",
    "# 发消息",
    `lark-cli im +messages-send --chat-id ${c.id} --text "<内容>"`,
    "```",
  );
  return lines.join("\n");
}

type AttachmentChat = Awaited<ReturnType<typeof handleListChats>>["chats"][number];
type AttachmentCache = {
  cacheKey: string;
  expiresAt: number;
  chats: AttachmentChat[];
  pages: number;
  nextPageToken?: string;
  done: boolean;
  loading?: Promise<void>;
  muted: Map<string, boolean>;
  muteLoading?: Promise<void>;
};

// 仅在当前插件进程内复用，不落盘；重载插件或一分钟后重新读取。
let attachmentCache: AttachmentCache | undefined;

export function resetAttachmentCache(): void {
  attachmentCache = undefined;
}

async function loadAttachmentPage(cache: AttachmentCache): Promise<void> {
  if (cache.loading) return cache.loading;
  if (cache.done) return;
  const loading = (async () => {
    const page = await handleListChats({ pageSize: 100, pageToken: cache.nextPageToken });
    const known = new Set(cache.chats.map((c) => c.id));
    cache.chats.push(
      ...page.chats.filter((c) => {
        if (known.has(c.id)) return false;
        known.add(c.id);
        return true;
      }),
    );
    cache.pages++;
    cache.done = cache.pages >= 5 || !page.hasMore || !page.nextPageToken;
    cache.nextPageToken = page.nextPageToken;
  })();
  cache.loading = loading;
  try {
    await loading;
  } finally {
    cache.loading = undefined;
  }
}

async function loadAllAttachmentPages(cache: AttachmentCache) {
  while (!cache.done) await loadAttachmentPage(cache);
}

async function getMutedChatIds(
  chats: { id: string }[],
  cache: AttachmentCache,
  deadline: number,
): Promise<Set<string> | null> {
  const muted = new Set<string>();
  try {
    // 群人设置接口每次最多 10 个 ID；限并发和总耗时，避免拖慢附件选择器。
    for (let i = 0; i < chats.length; i += 50) {
      const group = chats.slice(i, i + 50);
      while (group.some((c) => !cache.muted.has(c.id))) {
        if (cache.muteLoading) {
          await cache.muteLoading;
          continue;
        }
        const timeoutMs = Math.min(3_000, deadline - Date.now());
        if (timeoutMs <= 0) throw new Error("mute lookup timed out");
        const missing = group.filter((c) => !cache.muted.has(c.id));
        const batches = [];
        for (let j = 0; j < missing.length; j += 10) {
          batches.push(
            larkCli<{
              ok?: boolean;
              identity?: string;
              data?: { items?: { chat_id: string; is_muted?: boolean }[] };
            }>(
              [
                "im",
                "chat.user_setting",
                "batch_query",
                "--as",
                "user",
                "--data",
                JSON.stringify({ chat_ids: missing.slice(j, j + 10).map((c) => c.id) }),
              ],
              { timeoutMs },
            ),
          );
        }
        const loading = Promise.all(batches).then((results) => {
          if (results.some((r) => !r.ok || r.identity !== "user" || !Array.isArray(r.data?.items))) {
            throw new Error("mute lookup unavailable");
          }
          const values = new Map(
            results.flatMap((r) =>
              r.data!.items!.map((item) => [item.chat_id, item.is_muted === true] as const),
            ),
          );
          for (const c of missing) cache.muted.set(c.id, values.get(c.id) ?? false);
        });
        cache.muteLoading = loading;
        try {
          await loading;
        } finally {
          cache.muteLoading = undefined;
        }
      }
      for (const c of group) if (cache.muted.get(c.id)) muted.add(c.id);
      // 已查到足够填满窗口的普通候选时，后面的状态不再影响前 30 条。
      if (chats.slice(0, i + 50).filter((c) => !muted.has(c.id)).length >= 30) break;
    }
    return muted;
  } catch {
    // 权限不足、旧 CLI 或请求失败时保留全部候选，不用部分结果重排。
    console.warn("paseo-feishu: 无法读取免打扰设置，附件列表保留原有顺序");
    return null;
  }
}

export async function handleSearchFeishu({ query }: { query: string }) {
  try {
    const cacheKey = `${resolveLarkCliBin()}|${resolveStateDir()}`;
    if (!attachmentCache || attachmentCache.cacheKey !== cacheKey || Date.now() >= attachmentCache.expiresAt) {
      attachmentCache = {
        cacheKey,
        expiresAt: Date.now() + 60_000,
        chats: [],
        pages: 0,
        done: false,
        muted: new Map(),
      };
    }
    const cache = attachmentCache;
    if (!cache.pages) await loadAttachmentPage(cache);
    // 后续页在后台补齐；首批已有足够普通候选时不等待，搜索仍覆盖最近 500 条。
    const remaining = loadAllAttachmentPages(cache);
    void remaining.catch(() => {});
    const q = query.trim().toLowerCase();
    if (q) await remaining;
    let matched: AttachmentChat[];
    let muted: Set<string> | null;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const length = cache.chats.length;
      matched = cache.chats.filter((c) => !q || c.name.toLowerCase().includes(q));
      muted = await getMutedChatIds(matched, cache, deadline);
      if (
        q ||
        matched.filter((c) => !muted?.has(c.id)).length >= 30 ||
        (cache.done && cache.chats.length === length)
      ) {
        break;
      }
      if (cache.chats.length === length) await loadAttachmentPage(cache);
    }
    // 合并各页、按名称筛选后再稳定排序，最后截取；免打扰会话仍可搜索和附加。
    matched.sort((a, b) => Number(muted?.has(a.id) ?? false) - Number(muted?.has(b.id) ?? false));

    const brand = resolveLarkBrand(cache.chats.map((c) => c.appLink));

    return {
      items: matched.slice(0, 30).map((c) => {
        const kind = c.mode === "p2p" ? (c.targetType === "bot" ? "机器人" : "单聊") : "群聊";
        // CLI 不保证返回 chat_app_link，但宿主附件契约要求合法 URL。
        // openChatId 同时支持单聊与群聊，不能替换为用户的 openId。
        const appLink =
          c.appLink && URL.canParse(c.appLink) ? c.appLink : fallbackChatAppLink(c.id, brand);
        return {
          id: c.id,
          identifier: "",
          title: `[${kind}] ${c.name}`,
          subtitle: c.lastAttachedAt ? "最近附加过" : undefined,
          url: appLink,
          text: chatAttachText({ ...c, appLink }),
          resourceType: "feishu-chat",
        };
      }),
    };
  } catch (err) {
    // 附件源失败不抛错，返回空列表让 UI 显示"无结果"
    void err;
    return { items: [] };
  }
}

// ============ UI 状态 ============

/** 只记导航位置。轮询等配置归 settings.json。 */
type UiState = {
  activeTab?: "chats" | "tasks" | "agenda";
};

function uiStatePath(): string {
  return resolve(resolveStateDir(), "ui-state.json");
}

export async function handleGetUiState(): Promise<UiState> {
  const path = uiStatePath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const raw = parsed as Record<string, unknown>;
    const out: UiState = {};
    if (raw.activeTab === "chats" || raw.activeTab === "tasks" || raw.activeTab === "agenda") {
      out.activeTab = raw.activeTab;
    }
    return out;
  } catch {
    return {};
  }
}

export async function handleSetUiState(input: UiState) {
  try {
    const path = uiStatePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeAtomic(path, JSON.stringify(input, null, 2));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ============ 插件设置 ============

type SourceLaunchConfig = {
  workspaceMode?: "reuse" | "new" | "fixed";
  defaultDirectory?: string;
  fixedWorkspaceId?: string;
  /** "provider/model" 完整串 */
  provider?: string;
  thinkingOptionId?: string;
  modeId?: string;
  openingLine?: string;
};

type PluginSettings = {
  pollIntervalMs?: number;
  chat?: SourceLaunchConfig;
  task?: SourceLaunchConfig;
  agenda?: SourceLaunchConfig;
};

const POLL_CHOICES_MS = [0, 5_000, 10_000, 30_000, 60_000];

function settingsPath(): string {
  return resolve(resolveStateDir(), "settings.json");
}

/** 逐字段白名单，不信任文件内容。兼容旧版 workspaceMode="bridge"。 */
function sanitizeSource(raw: unknown): SourceLaunchConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: SourceLaunchConfig = {};
  if (r.workspaceMode === "new" || r.workspaceMode === "fixed" || r.workspaceMode === "reuse") {
    out.workspaceMode = r.workspaceMode;
  } else if (r.workspaceMode === "bridge") {
    out.workspaceMode = "reuse";
  }
  if (typeof r.defaultDirectory === "string" && r.defaultDirectory.trim()) {
    out.defaultDirectory = r.defaultDirectory.trim();
  }
  if (typeof r.fixedWorkspaceId === "string" && r.fixedWorkspaceId) {
    out.fixedWorkspaceId = r.fixedWorkspaceId;
  }
  if (typeof r.provider === "string" && r.provider) out.provider = r.provider;
  if (typeof r.thinkingOptionId === "string" && r.thinkingOptionId) {
    out.thinkingOptionId = r.thinkingOptionId;
  }
  if (typeof r.modeId === "string" && r.modeId) out.modeId = r.modeId;
  if (typeof r.openingLine === "string") out.openingLine = r.openingLine;
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function handleGetSettings(): Promise<PluginSettings> {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const raw = parsed as Record<string, unknown>;
    const out: PluginSettings = {};
    if (typeof raw.pollIntervalMs === "number" && POLL_CHOICES_MS.includes(raw.pollIntervalMs)) {
      out.pollIntervalMs = raw.pollIntervalMs;
    }
    const chat = sanitizeSource(raw.chat);
    const task = sanitizeSource(raw.task);
    const agenda = sanitizeSource(raw.agenda);
    if (chat) out.chat = chat;
    if (task) out.task = task;
    if (agenda) out.agenda = agenda;
    return out;
  } catch {
    return {};
  }
}

export async function handleSetSettings(input: PluginSettings) {
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeAtomic(path, JSON.stringify(input, null, 2));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ============ 新对话的 prompt 组装 ============

/** 会话：给定位参数 + 查询命令，不灌正文。 */
function chatPrompt(c: {
  id: string;
  name: string;
  mode: string;
  targetType?: string;
  appLink?: string;
}): string {
  return chatAttachText(c);
}

/** 待办和日程信息量小，直接内联比给命令实用。 */
function taskPrompt(t: { summary: string; dueAt?: string; url?: string; overdue?: boolean }): string {
  const lines = [`# 飞书待办：${t.summary}`, ""];
  if (t.dueAt) lines.push(`- 截止时间：${t.dueAt}${t.overdue ? "（已逾期）" : ""}`);
  if (t.url) lines.push(`- 链接：${t.url}`);
  lines.push("", "## 相关命令", "", "```bash", "lark-cli task +get-my-tasks --complete=false", "```");
  return lines.join("\n");
}

function agendaPrompt(e: {
  summary: string;
  start?: string;
  end?: string;
  location?: string;
  isVc?: boolean;
}): string {
  const lines = [`# 飞书日程：${e.summary}`, ""];
  if (e.start) lines.push(`- 时间：${e.start}${e.end ? ` ~ ${e.end}` : ""}`);
  if (e.location) lines.push(`- 地点：${e.location}`);
  if (e.isVc) lines.push("- 视频会议");
  lines.push("", "## 相关命令", "", "```bash", "lark-cli calendar +agenda", "```");
  return lines.join("\n");
}

export async function handleBuildPrompt(input: {
  kind: "chat" | "task" | "agenda";
  id: string;
  title: string;
}) {
  try {
    let text: string;
    if (input.kind === "chat") {
      // 从第一页找；找不到就用 id 兜底，不为了拿名字再拉全量
      const page = await handleListChats({ pageSize: 100 });
      const hit = page.chats.find((c) => c.id === input.id);
      text = chatPrompt(hit ?? { id: input.id, name: input.title, mode: "unknown" });
    } else if (input.kind === "task") {
      const r = await handleListTasks({ completed: false });
      const hit = r.tasks.find((t) => t.guid === input.id);
      text = taskPrompt(hit ?? { summary: input.title });
    } else {
      const r = await handleGetAgenda({});
      const hit = r.events.find((e) => e.id === input.id);
      text = agendaPrompt(hit ?? { summary: input.title });
    }
    return { ok: true, title: input.title.slice(0, 60), text };
  } catch (err) {
    return { ok: false, title: input.title, text: "", error: errText(err) };
  }
}
