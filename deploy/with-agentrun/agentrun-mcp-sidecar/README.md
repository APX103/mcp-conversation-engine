# AgentRun MCP Server

将阿里云 AgentRun Code Interpreter 作为 MCP 工具暴露，使任何支持 MCP 协议的 Agent 都能安全地执行 Python/JavaScript 代码。

## 功能

- **代码执行**: 在安全的沙箱环境中执行 Python 或 JavaScript 代码
- **自动依赖安装**: 检测并自动安装缺失的依赖包
- **手动包管理**: 支持手动安装指定的 pip/npm 包
- **状态查询**: 查看沙箱运行状态

## 安装

```bash
npm install agentrun-mcp-server -g
```

或从源码构建：

```bash
git clone <repository>
cd agentrun-mcp-server
npm install
npm run build
npm link
```

## 配置

1. 复制配置模板：

```bash
cp config.json.example config.json
```

2. 编辑 `config.json`，填入你的阿里云凭证：

```json
{
  "apiKey": "你的AgentRun API Key",
  "accountId": "你的阿里云主账号ID",
  "region": "cn-shanghai",
  "templateName": "default-code-interpreter",
  "sandboxIdleTimeout": 3600
}
```

3. （可选）在 AgentRun 控制台创建沙箱模板，名称与 `templateName` 一致。

## 使用

支持两种运行方式：**stdio（本地子进程）** 和 **HTTP/SSE（远程服务）**。

### 方式一：stdio（本地集成）

在支持 MCP 的应用配置中添加：

```json
{
  "mcpServers": {
    "agentrun": {
      "command": "node",
      "args": ["/path/to/agentrun-mcp-server/dist/index.js"],
      "env": {
        "AGENTRUN_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

### 方式二：HTTP/SSE（Docker 服务）

适合远程部署、多客户端共享、容器化场景。

#### Docker 部署

```bash
# 构建镜像
docker build -t agentrun-mcp-server .

# 运行（挂载配置文件）
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/config.json:/app/config.json \
  --name agentrun-mcp \
  agentrun-mcp-server
```

#### 本地运行 HTTP 服务

```bash
npm run build
npm run start:http
# 或通过环境变量指定端口
PORT=8080 npm run start:http
```

#### 客户端配置（SSE）

```json
{
  "mcpServers": {
    "agentrun": {
      "transport": "sse",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

> **注意**：MCP Streamable HTTP 传输需要客户端支持 MCP Protocol Version 2025-11-25 或更高。

### 可用工具

| 工具名 | 描述 |
|--------|------|
| `execute_code` | 执行 Python 或 JavaScript 代码 |
| `install_packages` | 安装指定的依赖包 |
| `sandbox_status` | 查看沙箱状态 |

### 示例

执行 Python 代码：

```json
{
  "tool": "execute_code",
  "arguments": {
    "code": "import pandas as pd\ndf = pd.DataFrame({'a': [1,2,3]})\nprint(df)"
  }
}
```

安装依赖：

```json
{
  "tool": "install_packages",
  "arguments": {
    "packages": ["pydantic", "requests"]
  }
}
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建
npm run build

# 本地测试 HTTP 服务
npm run start:http

# 测试
npm test
```

## 注意事项

- 沙箱实例最长生命周期为 6 小时
- 代码执行超时时间最大为 30 秒
- 依赖安装可能需要较长时间，请耐心等待
- HTTP 服务默认绑定 `0.0.0.0`，生产环境建议通过反向代理或防火墙限制访问

## 许可证

MIT
