<div align="center">

# koishi-plugin-chatluna-character

_让大语言模型进行角色扮演，伪装成群友_

## [![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-character)](https://www.npmjs.com/package/koishi-plugin-chatluna-character) [![npm](https://img.shields.io/npm/dm/koishi-plugin-chatluna-character)](https://www.npmjs.com/package/koishi-plugin-chatluna-character) ![node version](https://img.shields.io/badge/node-%3E=18-green) ![github top language](https://img.shields.io/github/languages/top/ChatLunaLab/chatluna-character?logo=github)

</div>

## 特性

1. 与 ChatLuna 深度集成，可直接使用 ChatLuna 中可用的模型与工具调用能力。
2. 支持预设热更新与切换，默认附带可直接改造的模板预设。
3. 支持群聊、私聊、分会话覆盖的分层配置结构。
4. 支持固定间隔触发、活跃度触发、空闲触发，以及 `next_reply`、`wake_up_reply` 主动触发。
5. 支持状态持久化、历史消息自动补全与上下文获取。
6. 可在预设中接入长期记忆，并将长期记忆内容注入角色上下文。
7. 支持图片输入、文件输入等多模态上下文，适用于原生多模态模型或配套多模态服务。
8. 支持引用消息、语音、Markdown、表情包、文件等多种回复形式。
9. 支持禁言词闭嘴、冷却回复、分段发送与模拟打字等行为控制。

## 部署

在 Koishi 插件市场搜索 `chatluna-character`，安装后启用即可。

**插件依赖 ChatLuna，请确保在 ChatLuna 启动后再启用本插件。**

## 用法

[伪装文档](https://chatluna.chat/ecosystem/other/character.html)
