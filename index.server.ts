/**
 * paseo-feishu 服务端入口：基于官方开源 lark-cli，将飞书 / Lark 会话、待办与日程接入 Paseo。
 */
import type { PluginServerContext, PluginServerContribution } from "@getpaseo/plugin/server";
import {
  handleBuildPrompt,
  handleGetAgenda,
  handleGetSettings,
  handleGetUiState,
  handleListChats,
  handleListTasks,
  handleRecordAttach,
  handleSearchChats,
  handleSearchFeishu,
  handleSetSettings,
  handleSetUiState,
  resetAttachmentCache,
} from "./server/feishu.ts";
import {
  buildPrompt,
  getAgenda,
  getSettings,
  getUiState,
  listChats,
  listTasks,
  recordAttach,
  searchChats,
  searchFeishu,
  setSettings,
  setUiState,
} from "./shared/feishu.ts";

const contribute: PluginServerContribution = (server: PluginServerContext) => {
  server.handle(listChats, handleListChats);
  server.handle(searchChats, handleSearchChats);
  server.handle(listTasks, handleListTasks);
  server.handle(getAgenda, handleGetAgenda);
  server.handle(searchFeishu, handleSearchFeishu);
  server.handle(recordAttach, handleRecordAttach);
  server.handle(buildPrompt, handleBuildPrompt);
  server.handle(getUiState, handleGetUiState);
  server.handle(setUiState, handleSetUiState);
  server.handle(getSettings, handleGetSettings);
  server.handle(setSettings, handleSetSettings);

  return () => {
    resetAttachmentCache();
  };
};

export default contribute;
