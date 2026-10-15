# GitHub Pages 网页版

在线入口：<https://zj05409.github.io/noname/>

打开即可使用原版 AI，点击「给我建议」默认获取本机原版建议，不需要账号或 API Key。牌局录像、AI 轨迹和设置保存在当前浏览器中。

## 可选 DeepSeek

网页每次载入都默认关闭 DeepSeek。需要使用时：

1. 打开「助手设置」，填写你自己的 DeepSeek API Key，点击「使用此 Key」。
2. 手动开启 DeepSeek，或点击「电脑原版，我用 DeepSeek 建议」。电脑与玩家建议可分别设置。
3. 点击「清除 Key」即可取消模型请求并恢复原版建议。

Key 只在当前页面的内存中保留；刷新或关闭网页后需要重新填写。不写入 localStorage、sessionStorage、录像或导出记录，不发送给 GitHub Pages、站点维护者或本机网关。浏览器只通过 HTTPS 直接请求 DeepSeek 官方接口。调用费用计入你提供的 Key 所属账号，实际 Token 用量可在牌局记录里查看。Key 无效、余额不足、网络失败和格式错误会显示具体原因，电脑会回退原版 AI。

Flash 处理具体选择和玩家建议，Pro 负责电脑回合规划；不自动重试。模型只接收决策者已知的牌与公开信息，完整录像仍只保存在本机。

## 网页版与 Mac 版

网页版包含全部图片、武将与音频路径。为符合 GitHub Pages 的 1 GB 站点限制，语音使用 48 kbps 单声道，背景音乐使用 96 kbps 双声道；不比原文件小的音频沿用原件。当前完整包约 948 MB，原始素材和 Mac 本地安装不变。

网页文件接口只读，配置、录像与 JSON 导入导出可用；需要往安装目录写文件的扩展安装、更新功能仍应在本地版完成。原版 AI 和只读建议均无需联网调用模型。

## 构建与发布

依赖 Node.js、pnpm 和 FFmpeg：

```sh
pnpm install --frozen-lockfile
pnpm test:deepseek
pnpm build:pages
```

输出位于 `dist-pages`，与本地版的 `dist` 分开。构建仅复制游戏和公开说明，从不读取网关私有配置。`static-files.json` 提供静态只读文件清单，导入映射及服务工作线程支持项目子目录。

`.github/workflows/pages.yml` 会在 `codex/deepseek-ai` 分支推送时构建并部署。工作流不需要 DeepSeek secret；Pages 发布只使用 GitHub 自身的部署授权。语音压缩缓存可重复使用，站点大于 980 MB 或存在符号链接、运行凭据文件时会拒绝发布。
