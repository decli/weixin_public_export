(function () {
  "use strict";

  const SCRIPT_ID = "codex-wechat-mp-local-exporter-script";
  if (document.getElementById(SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = chrome.runtime.getURL("wechat_mp_recent_export.user.js");
  script.onload = () => script.remove();

  (document.documentElement || document.head).appendChild(script);
})();
