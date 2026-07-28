# Pi Sol 单回合上下文保护

这是一个给 [Pi](https://github.com/earendil-works/pi-mono) 用的小扩展，主要解决一个很具体的问题：

当 `gpt-5.6-sol` 在同一回合里连续调用很多工具时，上下文可能已经很大，但 Pi 还没机会进入正常的自动压缩流程。这个扩展会在一次工具调用结束后找机会停下来，先让 Pi 压缩上下文，再自动接着完成原来的任务。

## 它什么时候会触发

以下条件必须同时满足：

- 当前模型是 `gpt-5.6-sol`；
- 模型刚完成了一次包含工具结果的响应；
- 本次响应报告的 token 数超过 `250,000`；
- 用户没有新消息正在排队；
- 扩展当前没有在处理上一轮压缩。

触发后，底部状态栏会显示压缩状态。压缩完成后，扩展会发送一条不可见的继续消息，让模型从压缩后的上下文继续工作。

如果 Pi 自己已经提供了同类的 `shouldStopAfterTurn` 能力，扩展会自动让位，不重复接管。

## 安装

### 先临时试用

在仓库目录中运行：

```bash
pi -e ./index.ts
```

这只对当前这次 Pi 运行生效。

### 安装到当前用户

最直接的方式是复制扩展文件：

```bash
mkdir -p ~/.pi/agent/extensions/sol-mid-turn-guard
cp index.ts ~/.pi/agent/extensions/sol-mid-turn-guard/index.ts
```

然后在 Pi 里运行：

```text
/reload
```

加载成功后，底部会显示 `Sol guard 250k`。

也可以把整个仓库作为本地 Pi 包安装：

```bash
pi install "$(pwd)"
```

## 查看状态

在 Pi 里运行：

```text
/sol-guard-status
```

它会告诉你扩展是否启用、当前阶段、触发阈值，以及已经自动续跑了多少次。

## 验证

测试脚本需要系统里已经全局安装 Pi：

```bash
npm run smoke
```

测试会检查多会话隔离、停止与续跑、压缩失败处理，以及 `/reload` 后不会重复打补丁。

## 卸载

如果是手动复制安装：

```bash
rm -rf ~/.pi/agent/extensions/sol-mid-turn-guard
```

如果是通过 `pi install` 安装，请用 `pi list` 查看记录，再用 `pi remove` 删除对应的包。卸载后运行一次 `/reload`。

这个扩展不会修改项目或全局的 `settings.json`；通过 `pi install` 安装时，Pi 自己会记录包路径。

## 注意事项

- 模型名和 `250,000` 阈值目前写在代码里，不能通过配置文件修改。
- 它只处理 `gpt-5.6-sol`，不是通用的上下文溢出保护。
- 它复用了 Pi 的正常压缩流程，因此压缩本身会产生一次额外的模型调用和相应 token 消耗。
- 它会包装 Pi 的底层 `Agent.createLoopConfig`。代码会在运行时检查结构，但 Pi 升级后仍有可能失效；遇到问题时先卸载扩展。
- Pi 扩展拥有与 Pi 进程相同的系统权限。安装任何第三方扩展前，都应该先看一遍源码。

## License

[MIT](LICENSE)
