# 头像直传 - pickCat 自定义头像工具

静态单页工具：登录社区账号，选择一张图片，由浏览器直接调用站点接口，把头像设置为该图片（`CUSTOM` 类型）。

- 无框架、无构建步骤、无第三方运行时依赖，三个文件即可运行
- 全部请求由本机浏览器发出，账号与密码不经过其他服务器
- 界面按 Material Design 3 实现：tonal 色板、state layer、filled text field、switch、card、snackbar、抽屉、明暗主题
- 图片在浏览器内转码为静态 WebP，并在上传前清洗 RIFF 容器（移除 ICCP、EXIF、XMP、ANIM 等块）

**环境要求**：现代浏览器（Chrome、Edge、Firefox、Safari 的近期版本）。本地开发服务器需要 Node.js 18 或更高版本。

**使用范围**：仅可用于本人持有并有权操作的账号。该工具依赖站点接口的一个已公开披露的校验缺失问题，详见 [SECURITY.md](SECURITY.md)。

---

## 目录

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构（MD3 布局） |
| `styles.css` | MD3 token 与组件样式（手写，含明暗两套色板） |
| `app.js` | 全部逻辑：登录、图片转码、直传、派生、回读校验 |
| `serve.mjs` | 本地开发服务器（零依赖 Node 脚本）：伺服静态文件 + 反代 `/api` |
| `avatar.webp`、`avatar.jpg` | 示例图片，可直接用于测试 |
| `.github/workflows/pages.yml` | 部署到 GitHub Pages 的工作流 |
| `LICENSE` | MIT 许可证 |
| `SECURITY.md` | 安全说明、缺陷背景与使用范围 |
| `CONTRIBUTING.md` | 问题反馈与代码提交约定 |

---

## 部署方式与限制

页面是纯静态资源，可以托管到任意静态服务器。但**能否调用接口取决于请求是否同源**，两条限制都由浏览器强制执行：

| 限制 | 表现 |
| --- | --- |
| 接口 CORS 白名单只放行站点自身域名 | 其他 Origin 的请求，服务端返回 `403`，且不返回 `Access-Control-Allow-Origin` |
| 会话 Cookie 为 `Secure; SameSite=Lax` | 页面与接口跨站时，浏览器不发送该 Cookie，登录态无法建立 |

结论：**GitHub Pages 上页面可以正常打开，但登录、上传、派生会被浏览器拦下**，静态托管本身没有绕开这两条限制的手段。若要在 Pages 上使用，必须配置一个中转地址（见下文「GitHub Pages」）。

### 方式一：本地开发服务器（开箱即用）

```bash
node serve.mjs            # 默认 http://127.0.0.1:8787
node serve.mjs --port 9000 --target https://cdsq.dao3.fun
# 亦可用环境变量：PORT / TARGET / HOST
```

页面在 `/`，接口在 `/api/**` 并由服务器反代到 `cdsq.dao3.fun`，两者对浏览器同源，会话 Cookie 正常携带，三个接口均可用。

### 方式二：以本地服务器作为 Pages 的中转

GitHub Pages 提供页面，中转由本机 `serve.mjs` 承担：

```bash
node serve.mjs --port 8787
```

然后在页面右上角设置中填写：

| 设置项 | 值 |
| --- | --- |
| 接口地址（Origin） | `https://cdsq.dao3.fun` |
| CORS 代理前缀 | `http://127.0.0.1:8787` |

`serve.mjs` 会转发请求、改写 `Set-Cookie` 的 `Domain`，并去掉上游的 CORS 响应头。此方式需要本机运行 Node。

### 方式三：部署到站点同域下

把本目录放到站点同域的任意路径（例如 `https://cdsq.dao3.fun/tools/avatar/`），无需后端，页面与接口同源，直接可用。

### 方式四：直接打开 `index.html`

页面正常渲染，但接口请求会被拒绝。页面顶部会给出对应提示，可用于查看界面。

---

## GitHub Pages

仓库已包含 `.github/workflows/pages.yml`。推送 `main` 分支后，在仓库 **Settings -> Pages -> Build and deployment -> Source** 选择 **GitHub Actions**，工作流会把 `index.html`、`styles.css`、`app.js` 发布到 Pages。

访问地址：`https://<用户名>.github.io/<仓库名>/`

该地址与接口跨域，需要配置中转后才能实际使用。可选两种：

**1. 本机 `serve.mjs` 作为中转**（最简单，但每次使用需启动本机服务）

```
接口地址（Origin）：https://cdsq.dao3.fun
CORS 代理前缀：     http://127.0.0.1:8787
```

**2. 自建无服务器中转**（Pages 独立可用）

需要一个能转发 Cookie 的 HTTPS 中转，要求：

- 转发 `Cookie`、`Content-Type`、`Idempotency-Key` 请求头到 `https://cdsq.dao3.fun`
- 改写响应中 `Set-Cookie` 的 `Domain` 属性（去掉或改为中转自身域名），否则浏览器不会保存
- 响应中返回 `Access-Control-Allow-Origin: <Pages 地址>`（不能为 `*`）与 `Access-Control-Allow-Credentials: true`
- 处理 `OPTIONS` 预检

页面只需把中转地址填入「CORS 代理前缀」，「接口地址」保持 `https://cdsq.dao3.fun`。

---

## 使用步骤

1. **登录**：填用户名 / 密码 -> 调用 `POST /api/v1/session`。成功后浏览器保存 `pickcat_session`（HttpOnly，脚本读不到）。可选「记住账号密码」写入本机 `localStorage`。
2. **选图**：点击或拖入图片。浏览器将其转码为静态 WebP（服务端仅接受 WebP，JPEG 与 PNG 会被 `422 FILE_IMAGE_INVALID / NOT_WEBP` 拒绝）。
   - 可选：居中裁成正方形、最长边限制为 1024px；
   - 编码质量可在设置里调（0.4–1.0），超过 9 MiB 会自动降质重编。
3. **执行**：`POST /api/v1/files`（multipart，`ownership=PERSONAL`，带 `Idempotency-Key`）-> 得到文件 UUID ->
   `PUT /api/v1/users/{userId}/avatar`，body：

   ```json
   { "type": "DERIVE", "sourceFileId": "<文件UUID>", "crop": { "left": 0, "top": 0, "right": 100, "bottom": 100 } }
   ```

   `crop` 是**源图像素框**（不是比例），整图即 `right/bottom` 等于图片宽高。
4. **回读校验**：重新 `GET /users/{id}`，确认 `avatar.type === "CUSTOM"`，并展示新头像（带 `?t=时间戳` 破缓存）。

侧栏会显示当前账号、图盘用量（`/file-storage`）以及按时间倒序的请求日志。

---

## 接口要点（逆向自站点自身的前端包）

| 接口 | 用途 | 备注 |
| --- | --- | --- |
| `POST /api/v1/session` | 登录 | 201 + `Set-Cookie: pickcat_session`（`Secure; HttpOnly; SameSite=Lax; Path=/`，有效期 7 天） |
| `GET /api/v1/session` | 读当前会话 | 401 表示未登录 |
| `DELETE /api/v1/session` | 注销 | — |
| `POST /api/v1/files` | 上传图片 | multipart：`ownership=PERSONAL` + `file`；**必须**带 `Idempotency-Key`（1–128 个可见 ASCII）；只接受静态 WebP；返回 `{ id }` |
| `PUT /api/v1/files/{fileId}/deletion` | 下架图片 | 释放容量有冷静期 |
| `GET /api/v1/file-storage` | 图盘用量 | 默认额度 20 MiB |
| `PUT /api/v1/users/{id}/avatar` | 换头像 | `type`: `PRESET`（`presetId`）/ `CUSTOM`（恢复保留槽）/ `DERIVE`（`sourceFileId` + `crop`） |
| `GET /api/v1/users/{id}/avatar` | 头像状态 | 含 `current`、`custom`、`derivationAvailableAt` |
| `GET /api/v1/users/{id}` | 用户资料 | 含 `avatar.type`，用于回读校验 |

其他约束：

- 上传前本页会清洗 WebP 容器：移除 ICCP、EXIF、XMP、ANIM 等块，只保留图像数据块（部分浏览器的 canvas 导出会附带 ICCP）。
- 服务端会把上传的 WebP 无损重编码至 384×384，成品体积可能大于上传文件（实测 4.3 KB 变为 11.7 KB）。
- 派生有 **24 小时冷却**（`derivationAvailableAt`），冷却期内不能再次 `DERIVE`，但可以切回预设或已保留的自定义槽。
- 客户端上传上限按 9 MiB 处理（服务端声明 10 MiB）。

---

## 设置项（右上角齿轮）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 接口地址（Origin） | 空 = 当前站点同源 | 跨域时填 `https://cdsq.dao3.fun` |
| CORS 代理前缀 | 空 | 拼接为 `前缀 + 目标地址`；支持 `{url}` 占位符（会做 URL 编码）。代理必须转发 Cookie 并返回 `Access-Control-Allow-Credentials: true` |
| WebP 质量 | 0.92 | 越高越接近原图 |
| 记住账号密码 | 关 | 仅写入本机 `localStorage`，无加密 |

配置存在 `localStorage` 的 `pickcat-avatar-tool/config`，凭据存在 `pickcat-avatar-tool/credentials`。

---

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面顶部提示「当前页面与接口不同源」 | 部署在 GitHub Pages 等第三方域名，且未配置中转地址。按上文填写「CORS 代理前缀」 |
| `请求未到达服务端` / CORS 报错 | 页面与接口不同源，或代理不可用。改用 `serve.mjs`、同源部署或有效中转 |
| `403` 且无 JSON body | 服务端拒绝了该 `Origin`（CORS 白名单），同上 |
| `422 FILE_IMAGE_INVALID / NOT_WEBP` | 上传内容不是 WebP。本页会自动转码；手动调用接口时需自行转换 |
| `400 VALIDATION_FAILED` 提到 `Idempotency-Key` | 上传缺少该请求头 |
| `401 UNAUTHENTICATED` | 会话过期，重新登录 |
| `409 CUSTOM_AVATAR_NOT_AVAILABLE` | 账号还没有保留的自定义头像，先用 `DERIVE` 派生一次 |
| 头像未变化 | 处于 24 小时派生冷却期；页面会提示可再次更换的时间 |
| 中转已通但登录后仍 401 | 中转未改写 `Set-Cookie` 的 `Domain`，浏览器丢弃了会话 Cookie |
| 跨域下登录成功但后续请求 401 | 浏览器未保存 `Secure` Cookie（仅 HTTPS 与 localhost 属于安全上下文） |

---

## 安全与合规说明

- 本页不含后端：请求由浏览器直达目标站点，凭据仅存在于页面内存，以及勾选保存后的本机 `localStorage`。
- 目标接口的 `DERIVE` 分支在服务端不校验自定义头像的等级限制，属于已公开反馈的缺陷利用路径。若服务端补充该校验，本页功能可能失效或头像被回滚。
- 请仅在本人持有并有权操作的账号上使用。完整说明见 [SECURITY.md](SECURITY.md)。

---

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。

第三方名称与接口均归其各自权利人所有，本项目与站点运营方无隶属关系。

