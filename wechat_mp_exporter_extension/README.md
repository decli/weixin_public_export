# WeChat MP Local Exporter Extension

This folder is a local Chrome extension wrapper for `wechat_mp_recent_export.user.js`.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the `wechat_mp_exporter_extension/` folder in this repository.

## Use

1. Open the WeChat MP backend recent-published page.
2. Use the `MP Exporter` panel.
3. Prefer `API+Content` when you want stats plus article text in one CSV.
4. Use `Content JSON` if you want full parsed HTML as well; CSV exports plain text only.

## Privacy Model

The extension injects a local page script into `https://mp.weixin.qq.com/*`.

It does not:

- send data to third-party servers
- store or export cookies
- store or export tokens
- bypass login, CAPTCHA, or permission checks
