# 使用手册

## 方式一：Tampermonkey / 油猴脚本

1. 在 Chrome 中安装 Tampermonkey。
2. 打开 Tampermonkey 管理面板，选择「添加新脚本」。
3. 删除默认内容，粘贴 `wechat_mp_recent_export.user.js`。
4. 保存脚本。
5. 打开微信公众号后台：`https://mp.weixin.qq.com/`。
6. 进入「近期发表」或包含已发表文章列表的页面。
7. 页面右下角会出现 `MP Exporter` 面板。

## 方式二：Chrome 已解压扩展

1. 打开 `chrome://extensions`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择项目中的 `wechat_mp_exporter_extension/` 目录。
5. 刷新微信公众号后台页面。

如果你修改了扩展目录中的代码，需要回到 `chrome://extensions` 点击该扩展的刷新按钮。

## 推荐工作流

### 只导出文章数据

点击：

```text
List CSV
```

脚本会按分页获取文章列表，并自动下载 CSV。

### 导出文章数据和正文

点击：

```text
List+Text
```

脚本会先获取文章列表，再逐篇访问文章公开链接，解析正文文本，最后下载 CSV。

正文 HTML 只保存在 JSON 导出里；CSV 默认导出正文纯文本。

正文采集可能耗时较长。中途可以点击：

```text
Pause CSV
```

脚本会请求停止当前任务，尽量中断正在进行的请求，并立即把当前已经采集到的结果生成 CSV 下载链接。

### API 模式失败时

点击：

```text
Page Fallback
```

该模式会尝试点击页面分页按钮并扫描当前页面 DOM。它比 API 模式慢，也更依赖微信后台页面结构，适合作为备用方案。

## 字段说明

CSV 可能包含以下字段：

- `publish_time`：后台列表返回的发布时间。
- `appmsg_id`：接口返回的文章 ID，便于去重。
- `publish_id`：接口返回的发布记录 ID。
- `idx`：同一次群发中的文章序号。
- `title`：文章标题。
- `status`：发布状态。
- `is_original`：是否原创。
- `read_num`：阅读数。
- `like_num`：点赞数。
- `share_num`：分享数。
- `favorite_or_collect_num`：收藏数或页面中对应位置的指标。
- `comment_num`：评论数或页面中对应位置的指标。
- `api_moment_like_num`：接口返回的看一看相关点赞字段。
- `content_url`：文章公开链接。
- `cover_url`：封面图链接。
- `article_title`：正文页解析出的标题。
- `article_author`：正文页解析出的作者或账号名。
- `article_publish_time`：正文页显示的发布时间。
- `article_text_len`：正文纯文本长度。
- `article_fetch_status`：正文采集状态，可能是 `ok`、`failed`、`skipped_deleted`、`skipped_no_url`。
- `article_fetch_error`：正文采集失败原因。
- `article_text`：正文纯文本。
- `source`：数据来源，可能是 `api`、`dom`、`content` 的组合。
- `collected_at`：本地采集时间。

## 面板操作

- 面板顶部可拖动。
- 点击 `-` 折叠成小按钮。
- 点击 `+` 展开。
- 点击 `Pause CSV` 暂停当前长任务，并立即导出当前结果。
- 点击 `Clear` 清空浏览器本地缓存。
- 每个按钮都带有浏览器原生悬浮提示，鼠标停留即可查看用途和注意事项。

## 调整采集节奏

脚本顶部有以下参数：

```js
const API_DELAY_RANGE_MS = [5000, 12000];
const CONTENT_DELAY_RANGE_MS = [9000, 22000];
const PAGE_CLICK_DELAY_RANGE_MS = [4000, 9000];
const SCROLL_DELAY_RANGE_MS = [2500, 6500];
const ERROR_BACKOFF_RANGE_MS = [45000, 90000];
```

数值单位是毫秒。想更保守，可以把范围调大。

## 常见问题

### 看不到面板

确认当前 URL 是 `https://mp.weixin.qq.com/` 下的后台页面，并刷新页面。

### API 模式提示失败

可能是登录态过期、页面 token 缺失、后台接口结构变更，或网络异常。重新打开公众号后台首页后再试；仍失败时用 `Page Fallback`。

### 正文为空

可能是文章链接不可访问、文章已删除、公开页结构变化，或请求被临时限制。可以稍后重试，或只导出列表数据。

列表数据不会因为正文失败而丢失。已删除或无正文链接的文章仍会保留在 CSV 中，并通过 `article_fetch_status` 标记。

### CSV 在 Excel 中乱码

脚本已添加 UTF-8 BOM。若仍乱码，可在 Excel 中通过「数据」导入 CSV，并选择 UTF-8。
