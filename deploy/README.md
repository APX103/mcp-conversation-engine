# 部署目录

本项目提供两种部署模式，选择适合你的方式。

## 模式一：纯 Agent 模式（推荐入门）

不含代码解释器，仅使用 web-search MCP 服务。

```bash
cd deploy/basic
docker compose up -d
```

访问：http://localhost:3000 或 http://localhost:5174

## 模式二：AgentRun 模式（完整功能）

包含 AgentRun 代码解释器，可执行代码。

**前置条件**：agentrun-mcp-server 需在项目根目录的 `../../../agentrun-mcp-server`

```bash
cd deploy/with-agentrun
docker compose up -d
```

## 验证 MCP 连接

```bash
# 查看后端日志
docker logs <backend-container> | grep MCP

# 预期输出：
# [MCP] Connected to web-search-prime: ...
# [MCP] Connected to agentrun: ...  # 仅 with-agentrun 模式
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
