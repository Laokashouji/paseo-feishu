import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildChildPath,
  fallbackChatAppLink,
  handleBuildPrompt,
  handleGetAgenda,
  handleGetSettings,
  handleGetUiState,
  handleListTasks,
  handleSetSettings,
  handleSetUiState,
  resolveLarkBrand,
  resolveLarkCliBin,
  resolveStateDir,
} from "../server/feishu.ts";

test("状态目录跨平台解析（显式变量 / XDG / APPDATA / 默认配置目录）", () => {
  assert.equal(resolveStateDir({ PASEO_FEISHU_DIR: "/custom/feishu" }, "darwin"), resolve("/custom/feishu"));
  assert.equal(resolveStateDir({ FEISHU_PLUGIN_DIR: "/alt/feishu" }, "linux"), resolve("/alt/feishu"));
  assert.equal(
    resolveStateDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/users/alice" }, "linux"),
    resolve("/xdg", "paseo-feishu"),
  );
  assert.equal(
    resolveStateDir({ HOME: "/users/alice" }, "darwin"),
    resolve("/users/alice", ".config", "paseo-feishu"),
  );
  assert.equal(
    resolveStateDir({ APPDATA: "/win/roaming", USERPROFILE: "/win/user" }, "win32"),
    resolve("/win/roaming", "paseo-feishu"),
  );
});

test("lark-cli 跨平台路径探测支持环境变量、PATH、macOS pnpm、NVM 版本排序", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-feishu-bin-"));
  try {
    // 1. 显式环境变量优先
    assert.equal(resolveLarkCliBin({ FEISHU_LARK_CLI_BIN: "/custom/lark-cli" }, "darwin"), "/custom/lark-cli");
    assert.equal(resolveLarkCliBin({ LARK_CLI_BIN: "/custom/lark-cli-2" }, "linux"), "/custom/lark-cli-2");

    // 2. macOS pnpm 全局目录
    const macHome = join(root, "mac-home");
    const macPnpmBin = join(macHome, "Library", "pnpm", "lark-cli");
    mkdirSync(join(macHome, "Library", "pnpm"), { recursive: true });
    writeFileSync(macPnpmBin, "", { mode: 0o700 });
    assert.equal(resolveLarkCliBin({ HOME: macHome, PATH: "" }, "darwin"), macPnpmBin);

    // 3. NVM 多版本取高版本
    const nvmHome = join(root, "nvm-home");
    const v18 = join(nvmHome, ".nvm", "versions", "node", "v18.19.0", "bin", "lark-cli");
    const v22 = join(nvmHome, ".nvm", "versions", "node", "v22.2.0", "bin", "lark-cli");
    mkdirSync(join(nvmHome, ".nvm", "versions", "node", "v18.19.0", "bin"), { recursive: true });
    mkdirSync(join(nvmHome, ".nvm", "versions", "node", "v22.2.0", "bin"), { recursive: true });
    writeFileSync(v18, "", { mode: 0o700 });
    writeFileSync(v22, "", { mode: 0o700 });
    assert.equal(resolveLarkCliBin({ HOME: nvmHome, PATH: "" }, "linux"), v22);

    // 4. PATH 里的优先于候选目录
    const pathBinDir = join(root, "path-bin");
    const pathBin = join(pathBinDir, "lark-cli");
    mkdirSync(pathBinDir, { recursive: true });
    writeFileSync(pathBin, "", { mode: 0o700 });
    assert.equal(resolveLarkCliBin({ HOME: macHome, PATH: pathBinDir }, "darwin"), pathBin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildChildPath 为 macOS 极简 PATH 补齐 Node 与 Homebrew 目录且去重", () => {
  const result = buildChildPath("/Users/alice/Library/pnpm/lark-cli", "/usr/bin:/bin", "darwin", "/opt/node/bin/node");
  assert.deepEqual(result.split(":"), [
    "/usr/bin",
    "/bin",
    "/Users/alice/Library/pnpm",
    "/opt/node/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
});

test("飞书 / Lark 品牌识别按环境变量 > lark-cli 配置 > 链接推断 > 默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-feishu-brand-"));
  try {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ apps: [{ appId: "cli_overseas", brand: "lark" }] }),
    );
    assert.equal(resolveLarkBrand([], { LARKSUITE_CLI_CONFIG_DIR: dir }), "lark");
    assert.equal(resolveLarkBrand([], { LARKSUITE_CLI_CONFIG_DIR: dir, FEISHU_BRAND: "feishu" }), "feishu");
    assert.equal(
      resolveLarkBrand(["https://applink.larksuite.com/client/chat/open?openChatId=oc_1"], {
        LARKSUITE_CLI_CONFIG_DIR: join(dir, "missing"),
      }),
      "lark",
    );
    assert.equal(
      resolveLarkBrand([], { LARKSUITE_CLI_CONFIG_DIR: join(dir, "missing") }),
      "feishu",
    );
    assert.equal(
      fallbackChatAppLink("oc_123", "lark"),
      "https://applink.larksuite.com/client/chat/open?openChatId=oc_123",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("设置页支持旧版 bridge 模式迁移、defaultDirectory 持久化与 uiState 清洗", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-feishu-settings-"));
  const previous = process.env.PASEO_FEISHU_DIR;
  process.env.PASEO_FEISHU_DIR = dir;
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        pollIntervalMs: 10_000,
        chat: { workspaceMode: "bridge", defaultDirectory: "  /Users/me/work  ", provider: "codex/gpt" },
      }),
    );
    const loaded = await handleGetSettings();
    assert.equal(loaded.pollIntervalMs, 10_000);
    assert.equal(loaded.chat?.workspaceMode, "reuse");
    assert.equal(loaded.chat?.defaultDirectory, "/Users/me/work");
    assert.equal(loaded.chat?.provider, "codex/gpt");

    assert.deepEqual(await handleSetSettings({ pollIntervalMs: 30_000, task: { workspaceMode: "new" } }), { ok: true });
    const updated = await handleGetSettings();
    assert.equal(updated.pollIntervalMs, 30_000);
    assert.equal(updated.task?.workspaceMode, "new");

    writeFileSync(join(dir, "ui-state.json"), JSON.stringify({ activeTab: "bridge" }));
    assert.deepEqual(await handleGetUiState(), {});
    assert.deepEqual(await handleSetUiState({ activeTab: "agenda" }), { ok: true });
    assert.deepEqual(await handleGetUiState(), { activeTab: "agenda" });
  } finally {
    if (previous === undefined) delete process.env.PASEO_FEISHU_DIR;
    else process.env.PASEO_FEISHU_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("待办、日程与 prompt 组装通过 lark-cli 正常工作，缺失 CLI 时返回清晰指引", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-feishu-handlers-"));
  const bin = join(dir, "lark-cli");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "task") {
  process.stdout.write(JSON.stringify({ data: { items: [
    { guid: "t1", summary: "整理周报", due_at: "2020-01-01T10:00:00Z", url: "https://feishu.cn/task/t1" }
  ] } }));
} else if (args[0] === "calendar") {
  process.stdout.write(JSON.stringify({ data: [
    { event_id: "e1", summary: "技术评审", start_time: { datetime: "2026-11-24T15:00:00+08:00" }, end_time: { datetime: "2026-11-24T16:00:00+08:00" }, vchat: { meeting_url: "https://vc.feishu.cn/j/1" } }
  ] }));
} else if (args[0] === "im") {
  process.stdout.write(JSON.stringify({ data: { chats: [{ chat_id: "oc_1", name: "产品群", chat_mode: "group" }], has_more: false } }));
}
`,
    { mode: 0o700 },
  );
  const prevBin = process.env.FEISHU_LARK_CLI_BIN;
  const prevDir = process.env.PASEO_FEISHU_DIR;
  process.env.FEISHU_LARK_CLI_BIN = bin;
  process.env.PASEO_FEISHU_DIR = dir;
  try {
    const tasks = await handleListTasks({ completed: false });
    assert.equal(tasks.available, true);
    assert.equal(tasks.tasks[0].guid, "t1");
    assert.equal(tasks.tasks[0].overdue, true);

    const agenda = await handleGetAgenda({});
    assert.equal(agenda.available, true);
    assert.equal(agenda.events[0].isVc, true);

    const chatBrief = await handleBuildPrompt({ kind: "chat", id: "oc_1", title: "产品群" });
    assert.equal(chatBrief.ok, true);
    assert.match(chatBrief.text, /--chat-id oc_1/);

    const taskBrief = await handleBuildPrompt({ kind: "task", id: "t1", title: "整理周报" });
    assert.equal(taskBrief.ok, true);
    assert.match(taskBrief.text, /已逾期/);

    const agendaBrief = await handleBuildPrompt({ kind: "agenda", id: "e1", title: "技术评审" });
    assert.equal(agendaBrief.ok, true);
    assert.match(agendaBrief.text, /视频会议/);

    process.env.FEISHU_LARK_CLI_BIN = join(dir, "nonexistent-lark-cli");
    const missing = await handleListTasks({ completed: false });
    assert.equal(missing.available, false);
    assert.match(missing.error, /找不到 lark-cli/);
  } finally {
    if (prevBin === undefined) delete process.env.FEISHU_LARK_CLI_BIN;
    else process.env.FEISHU_LARK_CLI_BIN = prevBin;
    if (prevDir === undefined) delete process.env.PASEO_FEISHU_DIR;
    else process.env.PASEO_FEISHU_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
