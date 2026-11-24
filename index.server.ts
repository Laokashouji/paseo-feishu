/**
 * paseo-feishu 服务端入口：基于官方开源 lark-cli，将飞书 / Lark 会话、待办与日程接入 Paseo。
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
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
} from "./server/feishu";
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
} from "./shared/feishu";

export default function contribute(server: PluginServerContext) {
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
}
