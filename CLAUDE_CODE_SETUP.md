# Claude Code 集成配置

## 🚀 快速配置

### 1. 确保 sider2api 服务运行
```bash
# 启动服务器
bun run dev

# 确认服务正常
curl http://localhost:4141/health
```

### 2. 配置 Claude Code

有两种配置方法：

#### 方法A：环境变量配置（推荐）
```bash
# 在终端中设置环境变量
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9-g1EGnVsEBs7aCJBb1pl699W_RvO1J85rxe8qX84OE8
export ANTHROPIC_MODEL=claude-3.7-sonnet
export ANTHROPIC_SMALL_FAST_MODEL=claude-3.7-sonnet

# 启动 Claude Code
claude
```

#### 方法B：配置文件方式
在项目根目录创建 `.claude/settings.json`：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.-g1EGnVsEBs7aCJBb1pl699W_RvO1J85rxe8qX84OE8",
    "ANTHROPIC_MODEL": "claude-3.7-sonnet",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-3.7-sonnet"
  }
}
```

## 🎯 支持的模型

| Claude Code 请求模型 | 映射到 Sider 模型 |
|---------------------|------------------|
| `claude-3.7-sonnet` | `claude-3.7-sonnet-think` |
| `claude-4-sonnet` | `claude-4-sonnet-think` |
| `claude-3-sonnet` | `claude-3.7-sonnet-think` |

## ✅ 功能验证

### 1. 基础对话测试
启动 Claude Code 后，尝试：
```
你好，请介绍一下自己
```

### 2. 编程任务测试
```
用 Python 写一个简单的计算器函数
```

### 3. 中英文混合测试
```
Create a TypeScript interface for a user profile, include Chinese comments
```

### 4. 流式响应测试
Claude Code 默认使用流式响应，您应该看到文字逐步显示，而不是一次性输出全部内容。

**✨ 现在 Claude Code 应该能正常显示回复内容了！**

## 🔧 故障排除

### 常见问题

1. **连接失败**
   ```bash
   # 检查服务是否运行
   curl http://localhost:4141/health
   
   # 检查端口是否被占用
   netstat -an | grep 4141
   ```

2. **认证失败**
   - 确认 token 是否正确设置
   - 检查 token 是否过期

3. **响应异常**
   - 查看 sider2api 服务日志
   - 确认网络连接正常

### 日志调试

启动服务时会显示详细日志：
```bash
bun run dev

# 查看请求日志
✅ Received Anthropic API request: { model: 'claude-3.7-sonnet', messageCount: 1 }
✅ Calling Sider API...
✅ Request completed successfully: { responseId: 'msg_xxx', outputTokens: 94 }
```

## 🎉 使用建议

1. **首次使用**: 建议先用简单的中文问候测试
2. **编程任务**: 支持代码生成、调试、重构等
3. **模型选择**: 推荐使用 `claude-3.7-sonnet` 或 `claude-4-sonnet`
4. **性能优化**: 服务会自动处理 token 计数和响应格式

---

**🎯 现在您可以在 Claude Code 中享受 Sider AI 的强大功能了！**
