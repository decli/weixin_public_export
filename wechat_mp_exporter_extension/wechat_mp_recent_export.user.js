// ==UserScript==
// @name         WeChat MP recent articles local exporter
// @namespace    local.codex.weixin
// @version      0.3.3
// @description  Locally export WeChat MP article stats and content. Supports API collection, page collection, CSV/JSON export, and a draggable/collapsible panel.
// @author       local
// @match        https://mp.weixin.qq.com/cgi-bin/home*
// @match        https://mp.weixin.qq.com/cgi-bin/appmsg*
// @match        https://mp.weixin.qq.com/cgi-bin/appmsgpublish*
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "codex_wechat_mp_recent_articles_v2";
  const OLD_STORE_KEY = "codex_wechat_mp_recent_articles_v1";
  const PANEL_POS_KEY = "codex_wechat_mp_exporter_panel_pos_v1";
  const PANEL_COLLAPSED_KEY = "codex_wechat_mp_exporter_collapsed_v1";

  const PAGE_SIZE = 10;
  const API_DELAY_RANGE_MS = [5000, 12000];
  const CONTENT_DELAY_RANGE_MS = [9000, 22000];
  const PAGE_CLICK_DELAY_RANGE_MS = [4000, 9000];
  const SCROLL_DELAY_RANGE_MS = [2500, 6500];
  const ERROR_BACKOFF_RANGE_MS = [45000, 90000];
  const MAX_RETRIES = 2;

  const METRIC_COLUMNS = [
    "read_num",
    "like_num",
    "share_num",
    "favorite_or_collect_num",
    "comment_num",
    "metric_6",
    "metric_7",
    "metric_8",
    "api_moment_like_num",
  ];

  const EXPORT_COLUMNS = [
    "appmsg_id",
    "publish_id",
    "idx",
    "publish_time",
    "title",
    "status",
    "is_original",
    ...METRIC_COLUMNS,
    "is_deleted",
    "source",
    "raw_numbers",
    "content_url",
    "cover_url",
    "article_title",
    "article_author",
    "article_publish_time",
    "article_text_len",
    "article_fetch_status",
    "article_fetch_error",
    "article_text",
    "collected_at",
  ];

  const STATE = {
    running: false,
    rows: loadRows(),
    totalCount: 0,
    collapsed: localStorage.getItem(PANEL_COLLAPSED_KEY) === "1",
    toastTimer: null,
    lastDownload: null,
  };

  installNetworkHooks();
  onReady(() => {
    installPanel();
    setTimeout(scanVisible, 1400);
  });

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(range) {
    const [min, max] = range;
    return Math.floor(min + Math.random() * Math.max(0, max - min));
  }

  async function politeDelay(label, range) {
    const ms = randomDelay(range);
    updatePanel(`${label}: waiting ${Math.ceil(ms / 1000)}s...`);
    await sleep(ms);
  }

  async function withRetries(label, task) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_RETRIES) break;
        await politeDelay(`${label} failed, retry ${attempt + 1}/${MAX_RETRIES}`, ERROR_BACKOFF_RANGE_MS);
      }
    }
    throw lastError;
  }

  function safeInt(value, fallback = "") {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return "";
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function directText(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue || "";
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeTitle(text) {
    return String(text || "")
      .replace(/\s*原创\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isLikelyTitle(text) {
    const t = normalizeTitle(text);
    if (t.length < 8 || t.length > 140) return false;
    if (/^(近期发表|已发表|原创|草稿|群发|广告|通知中心|账号成长|微信小店)$/.test(t)) return false;
    if (isTimeText(t)) return false;
    if (/^\d+$/.test(t)) return false;
    return /[\u4e00-\u9fa5A-Za-z]/.test(t);
  }

  function isTimeText(text) {
    return /^(20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s+\d{1,2}:\d{2}|(?:今天|昨天)\s+\d{1,2}:\d{2}|(?:星期|周)[一二三四五六日天]\s+\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})$/.test(
      String(text || "").trim(),
    );
  }

  function extractTimeFromText(text) {
    const patterns = [
      /(20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s+\d{1,2}:\d{2})/,
      /((?:今天|昨天)\s+\d{1,2}:\d{2})/,
      /((?:星期|周)[一二三四五六日天]\s+\d{1,2}:\d{2})/,
      /(\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})/,
    ];
    for (const pattern of patterns) {
      const match = String(text || "").match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function makeKey(row) {
    const url = String(row.content_url || "").trim();
    if (url) return `url:${url}`;
    const appmsgId = String(row.appmsg_id || "").trim();
    const idx = String(row.idx || "").trim();
    if (appmsgId) return `appmsg:${appmsgId}:${idx}`;
    const publishId = String(row.publish_id || "").trim();
    if (publishId) return `publish:${publishId}:${idx}:${String(row.title || "").trim()}`;
    return `title:${String(row.title || "").trim()}`;
  }

  function loadRows() {
    try {
      const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveRows() {
    localStorage.setItem(STORE_KEY, JSON.stringify(STATE.rows));
  }

  function mergeRows(rows) {
    const byKey = new Map(STATE.rows.filter((row) => row.title || row.appmsg_id || row.publish_id).map((row) => [makeKey(row), row]));
    for (const row of rows) {
      if (!row || (!row.title && !row.appmsg_id && !row.publish_id)) continue;
      const key = makeKey(row);
      const old = byKey.get(key) || {};
      const merged = { ...old };
      for (const [field, value] of Object.entries(row)) {
        if (value === undefined || value === null || value === "") continue;
        merged[field] = value;
      }
      merged.source = mergeSource(old.source, row.source);
      byKey.set(key, merged);
    }
    STATE.rows = Array.from(byKey.values());
    sortRows();
    saveRows();
    updatePanel();
  }

  function mergeSource(a, b) {
    return Array.from(new Set(String(`${a || ""},${b || ""}`).split(",").map((x) => x.trim()).filter(Boolean))).join(",");
  }

  function sortRows() {
    STATE.rows.sort((a, b) => {
      const ta = Date.parse(String(a.publish_time || "").replace(/-/g, "/")) || 0;
      const tb = Date.parse(String(b.publish_time || "").replace(/-/g, "/")) || 0;
      return tb - ta;
    });
  }

  function getLeafTextItems(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const items = [];
    let node = walker.currentNode;
    while (node) {
      const own = directText(node);
      if (own) items.push({ el: node, text: own, rect: node.getBoundingClientRect() });
      node = walker.nextNode();
    }
    return items;
  }

  function findMainArea() {
    const selectors = "main, [role=main], .weui-desktop-layout__main, .weui-desktop__main, .main, .content, body";
    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter(isVisible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: textOf(el) }))
      .filter((x) => x.text.includes("近期发表") || x.text.includes("已发表") || x.text.includes("原创"));
    candidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    return candidates[0]?.el || document.body;
  }

  function findRowRoot(seed) {
    let el = seed;
    let best = null;
    for (let depth = 0; el && depth < 10; depth += 1, el = el.parentElement) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const txt = textOf(el);
      const looksLikeRow =
        rect.width >= Math.min(560, window.innerWidth * 0.42) &&
        rect.height >= 50 &&
        rect.height <= 280 &&
        /已发表|原创|今天|昨天|星期|周|20\d{2}[-/年]|\d+\s+\d+/.test(txt) &&
        (el.querySelector("img") || /\d+\s+\d+/.test(txt));
      if (looksLikeRow) best = el;
    }
    return best;
  }

  function collectCandidateRoots() {
    const main = findMainArea();
    const roots = new Set();

    for (const img of Array.from(main.querySelectorAll("img"))) {
      if (!isVisible(img)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 36 || rect.height < 36 || rect.width > 260 || rect.height > 260) continue;
      const root = findRowRoot(img);
      if (root) roots.add(root);
    }

    for (const item of getLeafTextItems(main)) {
      if (!isLikelyTitle(item.text)) continue;
      const root = findRowRoot(item.el);
      if (root) roots.add(root);
    }

    return Array.from(roots);
  }

  function extractPublishTime(root) {
    return extractTimeFromText(textOf(root)) || findNearbyTime(root);
  }

  function findNearbyTime(root) {
    const main = findMainArea();
    const rootRect = root.getBoundingClientRect();
    const centerY = rootRect.top + rootRect.height / 2;
    const candidates = getLeafTextItems(main)
      .map((item) => ({ ...item, time: extractTimeFromText(item.text) }))
      .filter((item) => item.time)
      .filter((item) => Math.abs(item.rect.top + item.rect.height / 2 - centerY) < Math.max(46, rootRect.height * 0.45))
      .sort((a, b) => {
        const leftScoreA = a.rect.left < rootRect.left ? 0 : 1000;
        const leftScoreB = b.rect.left < rootRect.left ? 0 : 1000;
        const distA = Math.abs(a.rect.top + a.rect.height / 2 - centerY);
        const distB = Math.abs(b.rect.top + b.rect.height / 2 - centerY);
        return leftScoreA - leftScoreB || distA - distB;
      });
    return candidates[0]?.time || "";
  }

  function extractTitle(root) {
    const items = getLeafTextItems(root)
      .map((item) => ({ ...item, text: normalizeTitle(item.text) }))
      .filter((item) => isLikelyTitle(item.text));
    if (!items.length) return "";
    items.sort((a, b) => b.text.length - a.text.length || b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    return items[0].text;
  }

  function extractNumbers(root) {
    const rootRect = root.getBoundingClientRect();
    const items = getLeafTextItems(root)
      .filter((item) => /^\d+$/.test(item.text))
      .filter((item) => item.rect.left > rootRect.left + 70)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    const compact = [];
    for (const item of items) {
      const prev = compact[compact.length - 1];
      const sameSpot =
        prev &&
        Math.abs(prev.rect.left - item.rect.left) < 2 &&
        Math.abs(prev.rect.top - item.rect.top) < 2 &&
        prev.text === item.text;
      if (!sameSpot) compact.push(item);
    }
    return compact.map((item) => Number(item.text));
  }

  function extractUrl(root) {
    const link = Array.from(root.querySelectorAll("a[href]"))
      .map((a) => a.href)
      .find((href) => /mp\.weixin\.qq\.com\/s|cgi-bin\/appmsg/.test(href));
    return link || "";
  }

  function extractCover(root) {
    const img = Array.from(root.querySelectorAll("img"))
      .filter(isVisible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0];
    return img?.currentSrc || img?.src || "";
  }

  function extractDomRow(root) {
    const title = extractTitle(root);
    if (!title) return null;
    const nums = extractNumbers(root);
    const row = {
      publish_time: extractPublishTime(root),
      title,
      status: textOf(root).includes("已发表") ? "已发表" : "",
      is_original: textOf(root).includes("原创") ? "yes" : "",
      content_url: extractUrl(root),
      cover_url: extractCover(root),
      raw_numbers: nums.join("|"),
      collected_at: new Date().toISOString(),
      source: "dom",
    };
    METRIC_COLUMNS.slice(0, 8).forEach((name, index) => {
      row[name] = Number.isFinite(nums[index]) ? nums[index] : "";
    });
    return row;
  }

  function scanVisible() {
    if (!document.body) return [];
    const rows = collectCandidateRoots().map(extractDomRow).filter(Boolean);
    mergeRows(rows);
    toast(`Scanned ${rows.length}; total ${STATE.rows.length}.`);
    return rows;
  }

  function installNetworkHooks() {
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (!win || win.__codexWechatMpExportHooked) return;
    win.__codexWechatMpExportHooked = true;

    const originalFetch = win.fetch;
    if (typeof originalFetch === "function") {
      win.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const url = requestUrl(args[0]);
        if (url.includes("/cgi-bin/appmsgpublish")) {
          response
            .clone()
            .text()
            .then((text) => handleMaybePublishPayload(url, text, "api"))
            .catch(() => {});
        }
        return response;
      };
    }

    const xhrProto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (xhrProto && !xhrProto.__codexWechatMpExportHooked) {
      xhrProto.__codexWechatMpExportHooked = true;
      const originalOpen = xhrProto.open;
      const originalSend = xhrProto.send;
      xhrProto.open = function (method, url, ...rest) {
        this.__codexWechatMpExportUrl = String(url || "");
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrProto.send = function (...args) {
        this.addEventListener("load", () => {
          const url = this.__codexWechatMpExportUrl || "";
          if (url.includes("/cgi-bin/appmsgpublish")) {
            handleMaybePublishPayload(url, this.responseText, "api");
          }
        });
        return originalSend.apply(this, args);
      };
    }
  }

  function requestUrl(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (input.url) return String(input.url);
    return String(input);
  }

  function handleMaybePublishPayload(url, text, source) {
    if (!String(url || "").includes("/cgi-bin/appmsgpublish") && !String(text || "").includes("publish_page")) return;
    try {
      const data = JSON.parse(text);
      const parsed = parsePublishPage(data, source);
      if (parsed.totalCount) STATE.totalCount = Math.max(STATE.totalCount, parsed.totalCount);
      if (parsed.rows.length) mergeRows(parsed.rows);
    } catch (_) {
      // Ignore non-JSON responses, expired sessions, and unrelated requests.
    }
  }

  function decodeHtml(value) {
    if (typeof value !== "string") return value;
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }

  function parseNestedJson(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    if (typeof value !== "string") return {};
    const decoded = decodeHtml(value);
    try {
      return JSON.parse(decoded);
    } catch (_) {
      return {};
    }
  }

  function parsePublishPage(data, source = "api") {
    const publishPage = parseNestedJson(data?.publish_page);
    const publishList = Array.isArray(publishPage.publish_list) ? publishPage.publish_list : [];
    const rows = [];

    for (const item of publishList) {
      const publishInfo = parseNestedJson(item?.publish_info);
      const sentInfo = publishInfo.sent_info || {};
      const publishMeta = publishInfo.publish_info || {};
      const appmsgList = Array.isArray(publishInfo.appmsg_info)
        ? publishInfo.appmsg_info
        : Array.isArray(publishInfo.appmsgex)
          ? publishInfo.appmsgex
          : [];

      for (const msg of appmsgList) {
        if (!msg || typeof msg !== "object") continue;
        const isDeleted = asDeleted(msg.is_deleted);
        const lineInfo = msg.line_info || {};
        const timestamp = firstTimestamp(
          lineInfo.send_time,
          sentInfo.time,
          publishMeta.create_time,
          publishMeta.update_time,
          msg.create_time,
          msg.update_time,
        );
        const momentLikeNum = safeInt(msg.moment_like_num, 0);
        const oldLikeNum = safeInt(msg.old_like_num, 0);
        const likeNum = momentLikeNum > 0 ? momentLikeNum : oldLikeNum;
        const row = {
          appmsg_id: firstNonEmpty(msg.appmsgid, msg.appmsg_id, msg.id, lineInfo.appmsgid, ""),
          publish_id: firstNonEmpty(item.publish_id, item.id, publishInfo.publish_id, publishMeta.publish_id, ""),
          idx: firstNonEmpty(msg.idx, msg.itemidx, msg.item_idx, lineInfo.idx, ""),
          publish_time: formatTimestamp(timestamp),
          title: msg.title || (isDeleted ? "[已删除文章]" : ""),
          cover_url: msg.cover || "",
          content_url: msg.content_url || "",
          read_num: safeInt(msg.read_num),
          like_num: likeNum,
          share_num: safeInt(msg.share_num),
          api_moment_like_num: safeInt(msg.like_num),
          favorite_or_collect_num: pickInt(msg, ["favorite_num", "collect_num", "fav_num", "appmsg_fav_num"]),
          comment_num: pickInt(msg, ["comment_num", "comment_count", "comment_total_count", "appmsg_comment_count"]),
          is_deleted: isDeleted ? "yes" : "no",
          article_fetch_status: isDeleted ? "skipped_deleted" : msg.content_url ? "" : "skipped_no_url",
          status: "已发表",
          source,
          collected_at: new Date().toISOString(),
        };
        rows.push(row);
      }
    }

    return { rows: rows.filter((row) => row.title || row.appmsg_id || row.publish_id), totalCount: safeInt(publishPage.total_count, 0) };
  }

  function pickInt(obj, names) {
    for (const name of names) {
      const value = safeInt(obj?.[name]);
      if (value !== "") return value;
    }
    return "";
  }

  function asDeleted(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return /^(1|true|yes|y|deleted|已删除|删除)$/i.test(String(value || "").trim());
  }

  function firstTimestamp(...values) {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return "";
    const d = new Date(Number(timestamp) * 1000);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
      d.getSeconds(),
    )}`;
  }

  async function apiFetchPage(begin) {
    const token = getToken();
    if (!token) throw new Error("Missing token in current URL. Open the WeChat MP backend home page first.");
    const url = new URL("/cgi-bin/appmsgpublish", location.origin);
    url.searchParams.set("sub", "list");
    url.searchParams.set("begin", String(begin));
    url.searchParams.set("count", String(PAGE_SIZE));
    url.searchParams.set("token", token);
    url.searchParams.set("lang", "zh_CN");
    url.searchParams.set("f", "json");
    url.searchParams.set("ajax", "1");

    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: { Accept: "application/json, text/javascript, */*; q=0.01" },
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Non-JSON response at begin=${begin}: ${text.slice(0, 120)}`);
    }
    const ret = Number(data?.base_resp?.ret ?? 0);
    if (ret !== 0) throw new Error(`WeChat API ret=${ret}: ${data?.base_resp?.err_msg || "unknown error"}`);
    return parsePublishPage(data, "api");
  }

  function getToken() {
    const fromUrl = new URLSearchParams(location.search).get("token");
    if (fromUrl) return fromUrl;
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    return firstNonEmpty(win?.wx?.cgiData?.token, win?.wx?.data?.t, "");
  }

  async function collectAllApiRows(clearMode = "ask") {
    if (STATE.running) return;
    const clearFirst = clearMode === "always" || (clearMode === "ask" && STATE.rows.length ? confirm("Clear old collected rows first?") : false);
    if (clearFirst) {
      STATE.rows = [];
      saveRows();
    }

    STATE.running = true;
    updatePanel("API collecting...");
    try {
      let begin = 0;
      let page = 1;
      let totalCount = 0;
      while (STATE.running) {
        updatePanel(`API page ${page}, total ${STATE.rows.length}...`);
        const parsed = await withRetries(`API page ${page}`, () => apiFetchPage(begin));
        if (parsed.totalCount) totalCount = parsed.totalCount;
        if (parsed.totalCount) STATE.totalCount = parsed.totalCount;
        mergeRows(parsed.rows);
        if (!parsed.rows.length) break;
        begin += PAGE_SIZE;
        page += 1;
        if (totalCount && begin >= totalCount) break;
        await politeDelay("Next API page", API_DELAY_RANGE_MS);
      }
      const remote = STATE.totalCount ? ` / remote ${STATE.totalCount}` : "";
      toast(`API done. ${STATE.rows.length}${remote} rows.`);
      return STATE.rows;
    } catch (error) {
      alert(`API collection failed: ${error.message || error}`);
      toast("API failed. Try Pages CSV.");
      return [];
    } finally {
      STATE.running = false;
      updatePanel();
    }
  }

  async function apiAllCollectAndExport() {
    const rows = await collectAllApiRows("ask");
    if (rows && STATE.rows.length) {
      exportCsv("API collection complete");
    }
  }

  async function apiAllContentCsv() {
    const rows = await collectAllApiRows("ask");
    if (!rows || !STATE.rows.length) return;
    await collectArticleContents();
    if (STATE.rows.length) {
      exportCsv("API and content collection complete");
    }
  }

  async function collectArticleContents() {
    if (STATE.running) return;
    const contentCandidates = STATE.rows.filter((row) => row.content_url && row.is_deleted !== "yes");
    const skipped = STATE.rows.length - contentCandidates.length;
    if (!contentCandidates.length) {
      alert("No article URLs collected yet. Run API all CSV or Pages CSV first.");
      return;
    }

    STATE.running = true;
    let done = 0;
    let failed = 0;
    try {
      for (const row of contentCandidates) {
        if (!STATE.running) break;
        done += 1;
        if (row.article_text || row.article_content_html) {
          updatePanel(`Content ${done}/${contentCandidates.length}: cached`);
          continue;
        }
        updatePanel(`Content ${done}/${contentCandidates.length}: fetching...`);
        try {
          const content = await withRetries(`Content ${done}/${contentCandidates.length}`, () => fetchArticleContent(row.content_url));
          mergeRows([
            {
              ...row,
              ...content,
              article_fetch_status: "ok",
              article_fetch_error: "",
              source: mergeSource(row.source, "content"),
              collected_at: new Date().toISOString(),
            },
          ]);
        } catch (error) {
          failed += 1;
          mergeRows([
            {
              ...row,
              article_fetch_status: "failed",
              article_fetch_error: String(error?.message || error || "unknown error").slice(0, 300),
              collected_at: new Date().toISOString(),
            },
          ]);
        }
        if (done < contentCandidates.length) await politeDelay("Next article content", CONTENT_DELAY_RANGE_MS);
      }
      const kept = STATE.rows.length;
      toast(`Content done. ${contentCandidates.length - failed}/${contentCandidates.length} fetched, ${failed} failed, ${skipped} skipped, ${kept} rows kept.`);
    } finally {
      STATE.running = false;
      updatePanel();
    }
  }

  async function collectContentAndExportCsv() {
    await collectArticleContents();
    if (STATE.rows.length) exportCsv("Content collection complete");
  }

  async function collectContentAndExportJson() {
    await collectArticleContents();
    if (STATE.rows.length) exportJson("Content collection complete");
  }

  async function fetchArticleContent(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseArticleHtml(html, url);
  }

  function parseArticleHtml(html, url) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const contentEl =
      doc.querySelector("#js_content") ||
      doc.querySelector(".rich_media_content") ||
      doc.querySelector('[id*="content"]') ||
      doc.body;
    const contentClone = contentEl ? contentEl.cloneNode(true) : null;
    if (contentClone) normalizeArticleHtml(contentClone, url);
    const articleText = contentEl ? extractReadableText(contentEl) : "";
    return {
      article_title: cleanText(doc.querySelector("#activity-name")?.textContent || doc.querySelector("h1")?.textContent || doc.title || ""),
      article_author: cleanText(doc.querySelector("#js_name")?.textContent || doc.querySelector(".rich_media_meta_text")?.textContent || ""),
      article_publish_time: cleanText(doc.querySelector("#publish_time")?.textContent || ""),
      article_text_len: articleText.length,
      article_text: articleText,
      article_content_html: contentClone ? contentClone.innerHTML : "",
    };
  }

  function normalizeArticleHtml(root, baseUrl) {
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      if (src) img.setAttribute("src", absolutizeUrl(src, baseUrl));
    }
    for (const source of Array.from(root.querySelectorAll("source"))) {
      const src = source.getAttribute("data-src") || source.getAttribute("src") || "";
      if (src) source.setAttribute("src", absolutizeUrl(src, baseUrl));
    }
    for (const el of Array.from(root.querySelectorAll("script, style, iframe"))) {
      el.remove();
    }
  }

  function absolutizeUrl(src, baseUrl) {
    try {
      return new URL(src, baseUrl).toString();
    } catch (_) {
      return src;
    }
  }

  function extractReadableText(root) {
    const blockTags = new Set([
      "ADDRESS",
      "ARTICLE",
      "ASIDE",
      "BLOCKQUOTE",
      "BR",
      "DIV",
      "FIGCAPTION",
      "FIGURE",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "P",
      "PRE",
      "SECTION",
      "TABLE",
      "TR",
      "UL",
      "OL",
    ]);
    const pieces = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        pieces.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "IFRAME") return;
      if (tag === "BR") pieces.push("\n");
      for (const child of Array.from(node.childNodes)) walk(child);
      if (blockTags.has(tag)) pieces.push("\n");
    };
    walk(root);
    return cleanArticleText(pieces.join(""));
  }

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function cleanArticleText(text) {
    return String(text || "")
      .replace(/\r/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function autoScrollCollect() {
    if (STATE.running) return;
    STATE.running = true;
    updatePanel("Auto scrolling...");
    let stableRounds = 0;
    let lastCount = STATE.rows.length;

    for (let i = 0; i < 80 && STATE.running; i += 1) {
      scanVisible();
      const scrollTarget = findScrollableContainer();
      if (scrollTarget === document.scrollingElement || scrollTarget === document.documentElement) {
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
      } else {
        scrollTarget.scrollBy({ top: Math.floor(scrollTarget.clientHeight * 0.85), behavior: "smooth" });
      }
      await politeDelay("Next scroll", SCROLL_DELAY_RANGE_MS);
      stableRounds = STATE.rows.length === lastCount ? stableRounds + 1 : 0;
      lastCount = STATE.rows.length;
      if (stableRounds >= 5) break;
    }

    STATE.running = false;
    updatePanel();
    toast(`Scroll done. Total ${STATE.rows.length}.`);
  }

  function findScrollableContainer() {
    const candidates = Array.from(document.querySelectorAll("div, main, section"))
      .filter(isVisible)
      .filter((el) => el.scrollHeight > el.clientHeight + 200)
      .sort((a, b) => b.clientHeight - a.clientHeight);
    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function findNextButton() {
    const main = findMainArea();
    const mainRect = main.getBoundingClientRect();
    const selectors = [
      "button",
      "a",
      "[role=button]",
      "[tabindex]",
      ".weui-desktop-pagination__nav",
      ".weui-desktop-pagination__next",
      ".pagination-next",
      ".next",
      "span",
      "i",
    ].join(",");

    const scored = Array.from(document.querySelectorAll(selectors))
      .filter(isVisible)
      .map((el) => {
        const clickEl = clickableAncestor(el);
        const rect = clickEl.getBoundingClientRect();
        const label = [
          textOf(clickEl),
          clickEl.getAttribute("aria-label"),
          clickEl.getAttribute("title"),
          clickEl.className,
          el.className,
        ]
          .join(" ")
          .toLowerCase();
        let score = 0;
        if (/下一页|下页|下一|next|pager_next|pagination.*next|arrow.*right|right.*arrow|icon.*right/.test(label)) score += 80;
        if (/weui-desktop-pagination__nav/.test(label)) score += 30;
        if (rect.top > mainRect.top + mainRect.height * 0.55) score += 15;
        if (rect.left > window.innerWidth * 0.55) score += 10;
        if (/上一页|上页|prev|previous|left/.test(label)) score -= 100;
        if (/^\d+$/.test(textOf(clickEl))) score -= 40;
        if (isDisabled(clickEl)) score -= 1000;
        return { el: clickEl, rect, label, score };
      })
      .filter((x) => x.score > 0 && x.rect.width <= 180 && x.rect.height <= 80);

    const unique = [];
    const seen = new Set();
    for (const item of scored) {
      if (seen.has(item.el)) continue;
      seen.add(item.el);
      unique.push(item);
    }
    unique.sort((a, b) => b.score - a.score || b.rect.left - a.rect.left);
    return unique[0]?.el || null;
  }

  function clickableAncestor(el) {
    let current = el;
    for (let i = 0; current && i < 4; i += 1, current = current.parentElement) {
      const tag = current.tagName;
      const label = `${current.className || ""} ${current.getAttribute("role") || ""}`.toLowerCase();
      if (tag === "BUTTON" || tag === "A" || current.onclick || /button|btn|pagination|page|nav|next/.test(label)) return current;
    }
    return el;
  }

  function isDisabled(el) {
    return (
      el.getAttribute("disabled") !== null ||
      el.getAttribute("aria-disabled") === "true" ||
      /disabled|disable|不可用/.test(`${el.className || ""} ${textOf(el)}`)
    );
  }

  function visibleSignature() {
    return collectCandidateRoots().map((root) => extractTitle(root)).filter(Boolean).join("|");
  }

  async function clickNextPage() {
    const before = visibleSignature();
    const next = findNextButton();
    if (!next) return false;
    next.scrollIntoView({ block: "center", inline: "center" });
    await sleep(150);
    next.click();
    for (let i = 0; i < 30; i += 1) {
      await sleep(200);
      const after = visibleSignature();
      if (after && after !== before) return true;
    }
    return true;
  }

  async function autoPagesCollectAndExport() {
    if (STATE.running) return;
    const maxPages = Number(prompt("Max pages to collect by clicking next?", "30") || "30");
    if (!Number.isFinite(maxPages) || maxPages <= 0) return;
    const clearFirst = STATE.rows.length ? confirm("Clear old collected rows before page export?") : false;
    if (clearFirst) {
      STATE.rows = [];
      saveRows();
    }

    STATE.running = true;
    for (let page = 1; page <= maxPages && STATE.running; page += 1) {
      updatePanel(`Page ${page}/${maxPages}: scanning...`);
      scanVisible();
      if (page === maxPages) break;
      const moved = await clickNextPage();
      if (!moved) break;
      await politeDelay("Next page", PAGE_CLICK_DELAY_RANGE_MS);
    }
    STATE.running = false;
    updatePanel();
    toast(`Pages done. ${STATE.rows.length} rows.`);
    if (STATE.rows.length) exportCsv("Page collection complete");
  }

  function toCsv(rows) {
    const escapeCell = (value) => {
      const s = value === undefined || value === null ? "" : String(value);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [EXPORT_COLUMNS.join(","), ...rows.map((row) => EXPORT_COLUMNS.map((col) => escapeCell(row[col])).join(","))].join("\n");
  }

  function downloadText(filename, text, mime, reason = "Export ready") {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    if (STATE.lastDownload?.url) {
      URL.revokeObjectURL(STATE.lastDownload.url);
    }
    STATE.lastDownload = {
      filename,
      mime,
      size: blob.size,
      text,
      url,
      status: "ready",
      createdAt: new Date().toLocaleString(),
      reason,
    };
    updateDownloadLink();
    updatePanel(`${reason}. ${filename} is ready.`);

    const fallbackToAnchor = () => {
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        STATE.lastDownload.status = "auto-clicked";
        updateDownloadLink();
        toast(`Download prepared: ${filename}. If no save dialog appeared, click the download link in the panel.`);
        return true;
      } catch (error) {
        STATE.lastDownload.status = `manual needed: ${error?.message || error}`;
        updateDownloadLink();
        alert(`Download is ready, but auto-download was blocked. Click the download link in the MP Exporter panel.`);
        return false;
      }
    };

    if (typeof GM_download === "function") {
      try {
        GM_download({
          url,
          name: filename,
          saveAs: true,
          onload: () => {
            if (STATE.lastDownload?.url === url) {
              STATE.lastDownload.status = "saved";
              updateDownloadLink();
              updatePanel(`Saved or download started: ${filename}`);
            }
          },
          onerror: () => {
            fallbackToAnchor();
          },
          ontimeout: () => {
            fallbackToAnchor();
          },
        });
        STATE.lastDownload.status = "save dialog requested";
        updateDownloadLink();
        return true;
      } catch (_) {
        return fallbackToAnchor();
      }
    }
    return fallbackToAnchor();
  }

  function exportCsv(reason = "CSV export ready") {
    if (!STATE.rows.length) {
      alert("No rows collected yet. Run API all CSV or Scan first.");
      return false;
    }
    const csv = "\ufeff" + toCsv(STATE.rows);
    return downloadText(`wechat-mp-recent-${dateStamp()}.csv`, csv, "text/csv", reason);
  }

  function exportJson(reason = "JSON export ready") {
    if (!STATE.rows.length) {
      alert("No rows collected yet. Run API all CSV or Scan first.");
      return false;
    }
    return downloadText(`wechat-mp-recent-${dateStamp()}.json`, JSON.stringify(STATE.rows, null, 2), "application/json", reason);
  }

  function triggerLastDownload() {
    if (!STATE.lastDownload?.url) {
      alert("No prepared export file yet.");
      return;
    }
    const a = document.createElement("a");
    a.href = STATE.lastDownload.url;
    a.download = STATE.lastDownload.filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    STATE.lastDownload.status = "manual clicked";
    updateDownloadLink();
  }

  function updateDownloadLink() {
    const box = document.getElementById("codex-wechat-exporter-download");
    if (!box) return;
    box.textContent = "";
    if (!STATE.lastDownload?.url) {
      box.style.display = "none";
      return;
    }

    box.style.display = "block";

    const meta = document.createElement("div");
    meta.textContent = `${STATE.lastDownload.filename} (${formatBytes(STATE.lastDownload.size)})`;
    meta.style.fontWeight = "600";
    meta.style.marginBottom = "4px";
    box.appendChild(meta);

    const status = document.createElement("div");
    status.textContent = `${STATE.lastDownload.reason}; status: ${STATE.lastDownload.status}`;
    status.style.color = "#57606a";
    status.style.marginBottom = "6px";
    box.appendChild(status);

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", flexWrap: "wrap" });

    const link = document.createElement("a");
    link.href = STATE.lastDownload.url;
    link.download = STATE.lastDownload.filename;
    link.textContent = "Download file";
    Object.assign(link.style, {
      border: "1px solid #2da44e",
      borderRadius: "4px",
      padding: "5px 7px",
      background: "#2da44e",
      color: "#fff",
      textDecoration: "none",
      cursor: "pointer",
    });
    link.addEventListener("click", () => {
      STATE.lastDownload.status = "download link clicked";
      updateDownloadLink();
    });
    row.appendChild(link);

    row.appendChild(makeButton("Retry save", triggerLastDownload));
    box.appendChild(row);
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function copyJson() {
    const text = JSON.stringify(STATE.rows, null, 2);
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text);
    } else {
      navigator.clipboard?.writeText(text);
    }
    toast("Copied JSON.");
  }

  function clearRows() {
    if (!confirm("Clear collected rows stored in this browser?")) return;
    STATE.rows = [];
    saveRows();
    updatePanel();
  }

  function dateStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function toast(message) {
    updatePanel(message);
    clearTimeout(STATE.toastTimer);
    STATE.toastTimer = setTimeout(() => updatePanel(), 2000);
  }

  function makeButton(label, onClick) {
    const button = document.createElement("button");
    button.textContent = label;
    button.type = "button";
    button.addEventListener("click", onClick);
    Object.assign(button.style, {
      border: "1px solid #d0d7de",
      borderRadius: "4px",
      padding: "5px 7px",
      background: "#fff",
      cursor: "pointer",
      fontSize: "12px",
      lineHeight: "1.2",
    });
    return button;
  }

  function installPanel() {
    if (!document.body || document.getElementById("codex-wechat-exporter")) return;
    const panel = document.createElement("div");
    panel.id = "codex-wechat-exporter";
    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "2147483647",
      border: "1px solid #d0d7de",
      borderRadius: "8px",
      background: "rgba(255,255,255,0.97)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      color: "#1f2328",
      font: "12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      userSelect: "none",
    });

    const header = document.createElement("div");
    header.id = "codex-wechat-exporter-header";
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      cursor: "move",
      padding: "7px 8px",
      borderBottom: "1px solid #eaeef2",
      fontWeight: "600",
    });

    const title = document.createElement("div");
    title.id = "codex-wechat-exporter-title";
    title.textContent = "MP Exporter";
    title.style.whiteSpace = "nowrap";
    header.appendChild(title);

    const toggle = document.createElement("button");
    toggle.id = "codex-wechat-exporter-toggle";
    toggle.type = "button";
    toggle.textContent = "-";
    toggle.title = "Collapse or expand";
    Object.assign(toggle.style, {
      border: "1px solid #d0d7de",
      borderRadius: "4px",
      background: "#fff",
      cursor: "pointer",
      width: "24px",
      height: "22px",
      lineHeight: "16px",
    });
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setCollapsed(!STATE.collapsed);
    });
    header.appendChild(toggle);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.id = "codex-wechat-exporter-body";
    Object.assign(body.style, { padding: "8px" });

    const status = document.createElement("div");
    status.id = "codex-wechat-exporter-status";
    status.style.marginBottom = "8px";
    body.appendChild(status);

    const download = document.createElement("div");
    download.id = "codex-wechat-exporter-download";
    Object.assign(download.style, {
      display: "none",
      marginBottom: "8px",
      padding: "8px",
      border: "1px solid #d8dee4",
      borderRadius: "6px",
      background: "#f6f8fa",
      userSelect: "text",
    });
    body.appendChild(download);

    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", flexWrap: "wrap", gap: "6px" });
    buttons.append(
      makeButton("API all CSV", apiAllCollectAndExport),
      makeButton("API+Content", apiAllContentCsv),
      makeButton("Pages CSV", autoPagesCollectAndExport),
      makeButton("Content CSV", collectContentAndExportCsv),
      makeButton("Content JSON", collectContentAndExportJson),
      makeButton("Scan", scanVisible),
      makeButton("Scroll", autoScrollCollect),
      makeButton("CSV", exportCsv),
      makeButton("JSON", exportJson),
      makeButton("Copy", copyJson),
      makeButton("Stop", () => {
        STATE.running = false;
        updatePanel();
      }),
      makeButton("Clear", clearRows),
    );
    body.appendChild(buttons);

    const note = document.createElement("div");
    note.textContent = "Local only. Single-threaded polite pacing with retries/backoff.";
    Object.assign(note.style, { marginTop: "8px", color: "#57606a" });
    body.appendChild(note);
    panel.appendChild(body);

    document.body.appendChild(panel);
    applySavedPanelPosition(panel);
    installDrag(panel, header);
    setCollapsed(STATE.collapsed);
    updatePanel();
  }

  function applySavedPanelPosition(panel) {
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || "null");
    } catch (_) {
      pos = null;
    }
    const width = 288;
    const height = 178;
    const left = Number.isFinite(pos?.left) ? pos.left : window.innerWidth - width - 18;
    const top = Number.isFinite(pos?.top) ? pos.top : window.innerHeight - height - 18;
    panel.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - 80))}px`;
    panel.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - 46))}px`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function installDrag(panel, header) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener("pointerdown", (event) => {
      if (event.target && event.target.tagName === "BUTTON") return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      header.setPointerCapture?.(event.pointerId);
    });

    header.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const left = clamp(event.clientX - offsetX, 4, window.innerWidth - 48);
      const top = clamp(event.clientY - offsetY, 4, window.innerHeight - 38);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    header.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      header.releasePointerCapture?.(event.pointerId);
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    });
  }

  function setCollapsed(collapsed) {
    STATE.collapsed = Boolean(collapsed);
    localStorage.setItem(PANEL_COLLAPSED_KEY, STATE.collapsed ? "1" : "0");
    const panel = document.getElementById("codex-wechat-exporter");
    const body = document.getElementById("codex-wechat-exporter-body");
    const title = document.getElementById("codex-wechat-exporter-title");
    const toggle = document.getElementById("codex-wechat-exporter-toggle");
    const header = document.getElementById("codex-wechat-exporter-header");
    if (!panel || !body || !title || !toggle || !header) return;

    body.style.display = STATE.collapsed ? "none" : "block";
    title.textContent = STATE.collapsed ? "MP" : "MP Exporter";
    toggle.textContent = STATE.collapsed ? "+" : "-";
    header.style.borderBottom = STATE.collapsed ? "0" : "1px solid #eaeef2";
    panel.style.width = STATE.collapsed ? "64px" : "286px";
  }

  function updatePanel(message) {
    const status = document.getElementById("codex-wechat-exporter-status");
    if (!status) return;
    const total = STATE.totalCount ? ` / remote ${STATE.totalCount}` : "";
    status.textContent = message || `${STATE.rows.length}${total} rows${STATE.running ? " - running" : ""}`;
  }
})();
