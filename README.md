# 阿露的 Sol 调教插件

一个 Pi 扩展，提供两项能力：

- 为所有模型注入工程纪律，并为 `*-sol` 模型追加 Sol 专项纪律；
- 当 `gpt-5.6-sol` 或 `gpt-6-astra` 在工具回合后超过 token 阈值时，先停止、压缩上下文，再自动继续任务；仅匹配这两个准确模型 ID。

如果 Pi 已原生提供同类的回合后停止能力，插件会自动让位。

## 配置

插件依次读取两层配置：全局代理目录中的 `alu-sol.json`（通常是 `~/.pi/agent/alu-sol.json`），以及当前项目工作目录中的 `.pi/alu-sol.json`。不会查找父目录。

项目配置按字段覆盖全局配置；字段缺失或值无效时保留全局值，`disable: []` 可清空全局禁用项。任一文件缺失或 JSON 格式错误时只忽略该层，未知字段也会被忽略。两层都未提供有效字段时，默认 `disable=[]`、`guardThreshold=250000`。配置会在每次代理运行前重新读取，因此修改会从下一条消息或下一次运行起生效，无需重新安装或执行 `/reload`。

配置文件可包含：

```json
{
  "disable": ["sol-discipline"],
  "guardThreshold": 250000
}
```

`disable` 只控制纪律提示词注入，支持：

- `engineering-discipline`：不注入通用工程纪律；
- `sol-discipline`：不注入 Sol 专项纪律；
- `all` 或 `*`：两种纪律都不注入。

`all` 和 `*` 也不会关闭上下文保护。`guardThreshold` 只控制上下文保护的触发阈值，必须是正整数；缺失或无效时使用 `250000`。Sol 和 Astra 共用此阈值，在工具回合完成后检查用量，不预测下一回合的预算，因此仍可能跨过模型的加价线。

## 安装

从 GitHub 安装：

```bash
pi install https://github.com/aruru-project/pi-alu-sol-tuner
```

也可克隆后安装本地仓库：

```bash
git clone https://github.com/aruru-project/pi-alu-sol-tuner.git
cd pi-alu-sol-tuner
pi install "$(pwd)"
```

安装或更新后，在 Pi 中运行 `/reload`。状态栏会显示当前保护阈值。

临时试用本地源码：

```bash
pi -e ./index.ts
```

## 从旧版迁移

GitHub 仓库已从 `aruru-project/pi-sol-temp-ext` 更名为 `aruru-project/pi-alu-sol-tuner`。旧链接可能会重定向，但安装新版前仍应移除已安装的 `pi-sol-temp-ext` 或 `sol-mid-turn-guard`。旧 guard 与新版插件会挂接同一条保护路径，不能同时加载，否则可能冲突。

1. 运行 `pi list`，找到旧包，并用列表中显示的完整来源或路径执行 `pi remove`；不要自行改写来源。
2. 如果旧版是手动复制的，删除 `~/.pi/agent/extensions/sol-mid-turn-guard`。
3. 在 Pi 中运行 `/reload`。
4. 运行 `pi install https://github.com/aruru-project/pi-alu-sol-tuner` 安装新版。
5. 再次运行 `/reload`。

## 查看状态

在 Pi 中运行：

```text
/alu-sol-status
```

命令会显示插件是否运行、当前保护阶段、阈值和自动续跑次数。

## 验证

系统中已全局安装 Pi 时运行：

```bash
npm run smoke
```

使用 Dock 内嵌或其他非全局安装的 Pi 时，可指定包目录：

```bash
PI_CODING_AGENT_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent npm run smoke
```

测试覆盖纪律注入与关闭、默认及自定义阈值、Sol/Astra 停止/压缩/续跑、多会话隔离和重载安全。smoke 使用真实 Pi 扩展加载器及 Agent 回合钩子，压缩与续跑消息发送使用测试替身，不调用模型服务。

## 移除

先运行 `pi list`，再将列表中显示的完整来源或路径原样传给 `pi remove`：

```bash
pi list
pi remove 'pi list 显示的完整来源或路径'
```

移除后运行 `/reload`。

## License

[MIT](LICENSE)
