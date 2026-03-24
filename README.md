# 玄机 · 服务器管理后端

## 部署到 Render

### 1. 创建 GitHub 仓库
把 `server.js` 和 `package.json` 推到 GitHub

### 2. Render 创建 Web Service
- 登录 https://render.com
- 点 **New → Web Service**
- 连接你的 GitHub 仓库
- 设置：
  - **Name**: `xuanji-backend` (随便取)
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
  - **Instance Type**: Free 即可

### 3. 设置环境变量
在 Render 的 Environment 里添加：
- `AUTH_TOKEN` = 你设定的密钥（随便编一个强密码）
- `PORT` = 不用设，Render 自动分配

### 4. 部署
Render 会自动部署，完成后会给你一个 URL，类似：
```
https://xuanji-backend.onrender.com
```

### 5. 面板连接
在玄机面板里添加服务器：
- **后端地址**: 填 Render 给你的 URL
- **访问密钥**: 填你设的 AUTH_TOKEN
- **SSH 信息**: 填你VPS的 IP、端口、用户名、密码

---

## ⚠️ 注意事项

- Render 免费版会休眠（15分钟无请求），首次连接可能需要等 30 秒唤醒
- SSH 密码会通过 HTTPS 加密传输到 Render 后端
- 建议用私钥认证替代密码认证更安全
- 后端不会存储任何 SSH 凭证，每次连接时由前端传入
