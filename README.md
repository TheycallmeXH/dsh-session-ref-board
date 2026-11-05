# DSH 图片集 · session-ref-board

DSH 会话视图里的 PureRef 式无限图片画布。一整块可缩放、可平移的画布，图片可以随手拖进来、自由摆放、旋转、分组、加文字，**按会话独立保存**，重开对话还在。

它是一块画布，不是一个文件夹：没有文件列表、没有固定网格、没有缩略图墙。

```
对话  轨迹  上下文  图片集 …
                    └─ 一个 tab，铺满内容区
```

## 功能

**无限画布**
- 滚轮缩放（锚定光标，0.05×–8×）、中键/空格拖拽平移
- 适应全部（F）、适应选中（Shift+F）、回到原点 100%
- 背景四档：深灰 / 中性灰 / 浅色 / 跟随主题

**导入**
- 从资源管理器拖图片进来（落在光标处的世界坐标，不堆在原点）
- Ctrl+V 粘贴图片、`+` 按钮选文件批量导入
- 应用里任意图片右键 → 加入图片集
- 图片会被**复制**进插件自己的存储目录，源文件删了画布也不会烂

**操作**
- 拖动 / 四角缩放（拖任意一角，对角固定；图片默认锁比例，按 Alt 自由）
- 文字按**字号**缩放：拖角或右键「字号 ±2」，字始终不被拉扁
- 旋转手柄、层级：上移一层、下移一层、置顶、置底
- 多选（Shift 点击、空白处框选）、整组一起动
- 复制 / 剪切 / 粘贴 / 删除、撤销 / 重做（100 步）
- 右键菜单：加入输入框、对其提问、打开文件位置、复制文件路径、旋转、角度归零、组合/取消组合、移除

**排列**
- 网格整理、横向、纵向、左对齐、上对齐、水平居中、垂直居中、水平等距、垂直等距（右键「排列」子菜单）
- 只对选中生效；没有选中才作用于整块画布。排列永远是可选手动操作，导入时不会强制网格化

**文字**
- 画布任意位置加文字，双击编辑正文、字号（8–160）、颜色（或跟随主题）

**保存与导出**
- 每个会话一份文档：视角、每张图的位置/尺寸/旋转/层级/分组、文字、背景，400ms 防抖自动保存
- 导出 PNG（整块画布 / 可见区域 / 选中对象）、2 倍图、JPG
- 导出 / 导入项目 JSON（`.refboard` 风格的纯文本布局文件，不含图片二进制）

**把图交回对话**
- 双击卡片、右键「加入输入框」、或把卡片直接拖到画布外松手 → 图片进入输入框附件
- 「对其提问」会同时把这张图附上并插入 `关于这张图：`

## 快捷键

| 操作 | 键 |
|---|---|
| 选择 / 多选 / 框选 | 左键 / Shift+左键 / 空白处拖 |
| 平移画布 | 中键拖动、空格+左键、Alt+左键 |
| 缩放画布 | 滚轮 |
| 适应全部 / 适应选中 | F / Shift+F |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Shift+Z 或 Ctrl+Y |
| 复制 / 剪切 / 粘贴 | Ctrl+C / Ctrl+X / Ctrl+V |
| 全选 / 取消选择 | Ctrl+A / Esc |
| 删除 | Delete 或 Backspace |
| 保存到磁盘 | Ctrl+S |
| 加文字 | T |
| 组合 / 取消组合 | G / Shift+G |
| 旋转 90° | 右键菜单 |

快捷键在窗口任何位置都生效，输入框和可编辑区域里不会抢键。

## 安装

要求 DSH Desktop（Web GUI 同样适用）。插件是本地 bundle，不需要构建。

```bash
# 1. 放到任意目录，例如
git clone https://github.com/TheycallmeXH/dsh-session-ref-board.git
```

```text
# 2. 在 DSH 里安装这个目录（绝对路径）
plugin_manager install_bundle target=<绝对路径>/dsh-session-ref-board
```

```text
# 3. 确认 Host 行已激活
cordis_inspect_query(platform=provider Config, method=listConfigs, name=@local/session-ref-board)
GET  http://127.0.0.1:<port>/session-ref-board/ping  →  {"ok":true,"root":"…/session-ref-board"}
```

安装后**重启一次 DSH**：Client 半的 JS 只有在页面重新引导时才会加载（Desktop 生产版没有 Ctrl+R，`__DSH_BOOT__` 按请求时活行现算）。重启后对话顶部出现「图片集」tab。

`package.json` 里的 `name` 是 `@local/session-ref-board`，如果你改包名，`cordis.patch.yml` 的 `name` 与 `client.js` 里 `__ModuleLoader__.load({ id })` 必须同步改，三处必须一致。

## 数据位置

```
$DSH_HOME/session-ref-board/            # 默认 ~/.dsh/session-ref-board
├─ <slug>.json                          # 每个会话一份画布文档
└─ <slug>/                              # 该会话复制进来的图片
   ├─ <uuid>.png
   └─ board-<ts>.png                    # 导出的 PNG/JPG/JSON 也落在这里
```

`<slug>` = 可读会话名前缀 + sha1 前 12 位，会话 id 变了也不会串档。换机器只要带走整个目录即可。

## HTTP 接口（Host 半）

前缀 `/session-ref-board`，全部同源、无需额外端口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 健康检查，返回存储根 |
| GET | `/state?session=` | 读某会话的画布文档 |
| POST | `/state` | 写画布文档，body `{session, board}`（`application/json`） |
| GET | `/image?path=` | 读一张图（仅限插件存储根内） |
| POST | `/image?session=&name=` | 裸字节上传，复制进会话目录 |
| POST | `/export?session=&name=` | 裸字节导出落盘 |
| POST | `/remove` | 删除存储内的一张图，body `{path}` |
| POST | `/reveal` | 在资源管理器里定位该文件，body `{path}` |
| GET/POST | `/debug` | 无 devtools 时的诊断环形缓冲（200 条） |

## 安全边界

- **路径**：所有读写路径先 `resolve` 再 `relative` 判定，必须落在 `$DSH_HOME/session-ref-board` 内，否则 403；`/state` 里出现的外来 `path` 会被直接丢弃（导入的项目不能把图片路由指向别处）。
- **跨站**：`sec-fetch-site: cross-site` 或 `Origin` 与 `Host` 不一致的请求一律 403 —— 别的网站没法通过浏览器改动你的画布。
- **内容类型**：所有 JSON 路由要求 `application/json`（表单发不出来），上传只写进会话目录。
- **渲染**：图片走 `x-content-type-options: nosniff` + `content-security-policy: default-src 'none'; …; sandbox`，SVG 不会以文档身份执行。
- **体积**：请求体上限 128 MB，导出上限 64 MB，单板最多 400 个对象。
- **不联网**：插件没有任何外部请求。

## 测试

```bash
npm install     # 只有测试需要 react / react-dom / jsdom
npm test
```

| 套件 | 覆盖 |
|---|---|
| `test/host.test.mjs` | 真实 HTTP handler 往返 36 项：上传/读取/越权 403/畸形保存 400/跨站 403/非 JSON 415/nosniff/导出扩展名 |
| `test/slot.test.cjs` | 严格 Cordis Proxy：未 `inject` 就读服务必须抛错、样式回退、注册参数、CSS 断言、静态扫描 `ctx.<name>` |
| `test/mount.test.cjs` | `renderToStaticMarkup` 挂载两个入口，捕获 render 期异常 |
| `test/integration.test.cjs` | jsdom + `createRoot`：拖入落画布、T 加文字、Ctrl+A+Delete 清空并删盘、右键菜单点击真的执行、菜单在屏幕边缘被翻回视口 |
| `test/dep-order.test.cjs` | hook 依赖数组里“先用后声明”的 TDZ 扫描 |
| `test/menu-placement.test.cjs` | 菜单用实测尺寸而不是估算高度定位 |

DSH Desktop 没有 devtools，所以真机诊断走 `POST /debug` → `GET /debug` 的环形缓冲。

## 已知限制

- 分组是逻辑分组（`groupId`），没有组外框和组标题；标题请用文字对象。
- 选中命中仍按未旋转矩形计算，旋转 45° 的卡片边角可能点空。
- 导出边长上限 4096 写死（2 倍图同样受此限）。
- 没有“最近项目”列表；导入/导出项目走菜单里的 JSON 文件。

## 许可

MIT
