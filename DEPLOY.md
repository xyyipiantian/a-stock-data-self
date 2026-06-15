# Alpha Lens 多用户部署说明

## 目标

- 每个用户可注册 / 登录
- 每个用户有自己的自选监控
- 每个用户有自己的飞书 / 企业微信提醒渠道
- 提醒互不干扰

## 推荐组合

- 应用服务: 免费 Node 运行环境或你自己的云服务器
- 账号与数据库: Supabase
- OAuth: Google / GitHub
- 定时提醒: 定时访问 `/api/cron/dispatch`

## 1. 安装依赖

```bash
npm install
```

## 2. 配置环境变量

参考 [.env.example](C:\Users\59110\Documents\New project\.env.example)

至少需要：

```bash
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
MONITOR_CRON_SECRET=...
```

## 3. 创建 Supabase 表

在 Supabase SQL Editor 执行：

```sql
-- 见 supabase/schema.sql
```

文件路径：

[supabase/schema.sql](C:\Users\59110\Documents\New project\supabase\schema.sql)

## 4. 配置登录

在 Supabase Auth 里开启：

- Google OAuth
- GitHub OAuth

回调地址示例：

```text
https://your-domain.com
```

## 5. 启动应用

```bash
npm start
```

## 6. 触发提醒派发

### 方式 A：直接跑命令

```bash
npm run dispatch:alerts
```

### 方式 B：定时请求 HTTP 接口

```text
POST /api/cron/dispatch
Header: x-monitor-secret: <MONITOR_CRON_SECRET>
```

你可以用：

- 服务器 cron
- GitHub Actions schedule
- cron-job.org

## 7. 用户侧配置

用户登录后可在页面中：

- 保存自己的飞书机器人 webhook
- 保存自己的企业微信机器人 webhook
- 维护自己的自选监控

## 当前实现边界

- 个人微信未接入
- 阈值仍由系统默认策略生成
- 提醒频率去重窗口为 45 分钟
- webhook 明文存储在数据库，生产建议后续增加加密
