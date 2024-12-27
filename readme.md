<div align="center">

# koishi-plugin-chatluna-character

_让大语言模型进行角色扮演，伪装成群友_

## [![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-character)](https://www.npmjs.com/package/koishi-plugin-chatluna-character) [![npm](https://img.shields.io/npm/dm/koishi-plugin-chatluna-character)](https://www.npmjs.com/package/koishi-plugin-chatluna-character) ![node version](https://img.shields.io/badge/node-%3E=18-green) ![github top language](https://img.shields.io/github/languages/top/ChatLunaLab/chatluna-character?logo=github)

</div>

## 特性

1. 与 ChatLuna 集成，直接使用 ChatLuna 的模型。
2. 语句分割回复，支持 AI 自分割和按标点符号分割。
3. 支持触发多 AT，Markdown 渲染回复。
4. 禁言词支持，冷却回复，固定回复轮次，活跃度计算。
5. 联网搜索支持。
6. 图片多模态支持，针对原生多模态模型有效。
7. 使用任何在 `ChatLuna` 里可用的模型。
8. 热更新和切换可用的预设。

## 部署

在 Koishi 插件市场搜索 `chatluna-character`，安装后启用即可。

**插件依赖 ChatLuna，请确保在 ChatLuna 启动后再启用本插件。**

## 已知问题

伪装插件在短期内不提供长期记忆或上下文聊天记录的实现。如有这方面的需求，请使用 ChatLuna 主插件。

## 用法

[伪装文档](https://chatluna.chat/ecosystem/other/character.html)
