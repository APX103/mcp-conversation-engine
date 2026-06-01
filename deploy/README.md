# 部署目录

本项目提供三种部署模式，选择适合你的方式。

## 模式一：纯 Agent 模式（推荐入门）

不含代码解释器，仅使用 web-search MCP 服务。

```bash
cd deploy/basic
docker compose up -d
```

访问：http://localhost:3000 或 http://localhost:5174

## 模式二：AgentRun 模式（代码解释器）

包含 AgentRun 代码解释器，可执行代码。

**前置条件**：agentrun-mcp-server 需在项目根目录的 `../../../agentrun-mcp-server`

```bash
cd deploy/with-agentrun
docker compose up -d
```

## 模式三：Daytona 模式（企业沙盒）

使用 Daytona 沙盒执行代码，支持内网部署。

**前置条件**：需要 Daytona 服务器运行在 `http://10.1.52.70:3080/api`

```bash
cd deploy/daytona
docker compose up -d
```

**架构**：使用 sidecar 容器 (`daytona-mcp`) 提供 MCP 服务，backend 通过 HTTP 连接。

**环境变量**（可选）：
- `DAYTONA_API_URL` - Daytona 服务地址（默认：`http://10.1.52.70:3080/api`）
- `DAYTONA_TOOLBOX_URL` - Daytona Toolbox 地址（默认：`http://10.1.52.70:4000/toolbox`）
- `DAYTONA_API_KEY` - Daytona API 密钥

## 验证 MCP 连接

```bash
# 查看后端日志
docker logs <backend-container> 2>&1 | grep MCP

# 预期输出：
# [MCP] Connected to daytona: mcp__daytona__run_code, mcp__daytona__create_sandbox, ...
```

## 配置说明

每个模式目录包含：

- `docker-compose.yml` - 服务编排文件
- `config.example.json` - 配置模板（API key 占位符）
- `config.json` - 实际配置（含 API key，可直接使用，已在 .gitignore）

## 清理

```bash
docker compose down
```

删除数据：
```bash
docker compose down -v
```
