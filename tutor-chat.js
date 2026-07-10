/* AI Tutor Chat — zero-build, file://-safe embeddable widget.
   Usage: TutorChat.mount(document.body, { subject, providers?, storageKey? }) */
window.TutorChat = (function(){

  var DEFAULT_PRESETS = {
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-2.5-flash", needsKey: true, canSearch: false
    },
    local: {
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3.5:9b", needsKey: false, canSearch: true
    },
    custom: { baseUrl: "", model: "", needsKey: false, canSearch: false }
  };

  // Local "thinking" models (e.g. Qwen3.x) can burn most/all of their output
  // budget on internal reasoning before ever emitting a real answer. This
  // instruction measurably cuts reasoning length (~3x shorter in testing)
  // when appended to the system prompt. Toggled via the "Fix thinking model"
  // setting.
  var THINKING_FIX_HINT = "Do not overthink. Reply directly and concisely. If multiple options come to mind, pick one immediately — do not reconsider your answer more than once before responding.";

  function resolvePreset(presets, name){
    return (presets && presets[name]) || presets.custom || DEFAULT_PRESETS.custom;
  }

  function buildSystemPrompt(template, contextText){
    var ctx = contextText ? contextText : "";
    return template.replace("{{CONTEXT}}", ctx).replace(/\s+$/, "");
  }

  function buildMessages(systemPrompt, history, userMessage){
    var msgs = [{ role: "system", content: systemPrompt }];
    (history || []).forEach(function(m){ msgs.push({ role: m.role, content: m.content }); });
    msgs.push({ role: "user", content: userMessage });
    return msgs;
  }

  function classifyError(err, resp){
    if(resp && (resp.status === 401 || resp.status === 403))
      return { kind: "auth", message: "API key missing or rejected — check your provider settings." };
    if(resp && resp.status >= 500)
      return { kind: "server", message: "The model server returned an error. Try again." };
    if(err && err.name === "TypeError")
      return { kind: "cors", message: "Couldn't reach the provider — it may block browser calls (CORS), not have CORS headers, or be offline. Check your server config and Base URL." };
    return { kind: "unknown", message: (err && err.message) || "Something went wrong." };
  }

  function normalizeSearchResults(json){
    var arr = (json && json.results) || [];
    return arr.slice(0, 5).map(function(r){
      return {
        title: r.title || "",
        url: r.url || r.href || "",
        snippet: r.content || r.snippet || r.description || ""
      };
    });
  }

  function createClient(config){
    var baseUrl = (config.baseUrl || "").replace(/\/?$/, "/");
    function authHeaders(){
      var h = { "Content-Type": "application/json" };
      if(config.apiKey) h["Authorization"] = "Bearer " + config.apiKey;
      return h;
    }

    async function mockComplete(messages, opts){
      opts = opts || {};
      var lastUser = "";
      for(var i = messages.length - 1; i >= 0; i--){ if(messages[i].role === "user"){ lastUser = messages[i].content; break; } }
      var toolNote = "";
      if(opts.tools && opts.tools.length && /search:/i.test(lastUser) && opts.runTool){
        var q = lastUser.replace(/.*search:\s*/i, "");
        toolNote = await opts.runTool("web_search", { query: q });
      }
      var reply = "[mock] " + (toolNote ? ("Based on " + toolNote + " — ") : "") + "answer to: " + lastUser;
      if(opts.onToken){ reply.split(" ").forEach(function(w){ opts.onToken(w + " "); }); }
      return opts.onToken ? reply.split(" ").map(function(w){return w+" ";}).join("") : reply;
    }

    async function once(messages, opts){
      opts = opts || {};
      var body = { model: config.model, messages: messages, stream: !!opts.onToken, max_tokens: config.maxTokens || 4096 };
      if(opts.tools && opts.tools.length) body.tools = opts.tools;
      var resp;
      try{
        resp = await fetch(baseUrl + "chat/completions", {
          method: "POST", mode: "cors", headers: authHeaders(), body: JSON.stringify(body)
        });
      }catch(err){ throw classifyError(err, null); }
      if(!resp.ok){ throw classifyError(null, resp); }

      if(!opts.onToken){
        var data = await resp.json();
        return data.choices && data.choices[0] && data.choices[0].message || {};
      }
      var reader = resp.body.getReader(), decoder = new TextDecoder(), buf = "";
      var content = "", toolCalls = [];
      while(true){
        var chunk = await reader.read(); if(chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split("\n"); buf = lines.pop();
        for(var li = 0; li < lines.length; li++){
          var line = lines[li].trim();
          if(!line || line.indexOf("data:") !== 0) continue;
          var payload = line.slice(5).trim();
          if(payload === "[DONE]") continue;
          var json; try{ json = JSON.parse(payload); }catch(e){ continue; }
          var delta = json.choices && json.choices[0] && json.choices[0].delta || {};
          if(delta.content){ content += delta.content; opts.onToken(delta.content); }
          if(delta.tool_calls){
            delta.tool_calls.forEach(function(tc){
              var idx = tc.index || 0;
              toolCalls[idx] = toolCalls[idx] || { id: tc.id, type: "function", function: { name: "", arguments: "" } };
              if(tc.id) toolCalls[idx].id = tc.id;
              if(tc.function && tc.function.name) toolCalls[idx].function.name = tc.function.name;
              if(tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            });
          }
        }
      }
      return { content: content, tool_calls: toolCalls.filter(Boolean) };
    }

    async function complete(messages, opts){
      opts = opts || {};
      if(baseUrl.indexOf("mock://") === 0) return mockComplete(messages, opts);
      var convo = messages.slice();
      for(var round = 0; round < 4; round++){
        var msg = await once(convo, opts);
        var calls = msg.tool_calls || [];
        if(!calls.length || !opts.runTool) return msg.content || "";
        convo.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
        for(var c = 0; c < calls.length; c++){
          var call = calls[c], args = {};
          try{ args = JSON.parse(call.function.arguments || "{}"); }catch(e){ args = {}; }
          var result = await opts.runTool(call.function.name, args);
          convo.push({ role: "tool", tool_call_id: call.id, content: String(result) });
        }
      }
      var finalMsg = await once(convo, { onToken: opts.onToken });
      return finalMsg.content || "";
    }

    return { complete: complete };
  }

  // ---- self-contained persistence (namespaced localStorage) ----
  function makeStore(namespace){
    var configKey = namespace + ".config";
    var historyKey = namespace + ".history";
    return {
      getConfig: function(){
        try{ return JSON.parse(localStorage.getItem(configKey)) || {}; }catch(e){ return {}; }
      },
      setConfig: function(patch){
        var c = this.getConfig();
        Object.assign(c, patch);
        localStorage.setItem(configKey, JSON.stringify(c));
      },
      getHistory: function(){
        try{ return JSON.parse(localStorage.getItem(historyKey)) || []; }catch(e){ return []; }
      },
      pushMessage: function(m){
        var h = this.getHistory(); h.push(m);
        localStorage.setItem(historyKey, JSON.stringify(h));
      },
      clearHistory: function(){ localStorage.removeItem(historyKey); }
    };
  }

  // ---- DOM: mount a floating FAB + slide-over panel into a container ----
  function mount(container, config){
    config = config || {};
    var subject = config.subject || {
      name: "Tutor",
      systemTemplate: "You are a helpful tutor. Answer the user's questions clearly and concisely.\n{{CONTEXT}}"
    };
    var presets = Object.assign({}, DEFAULT_PRESETS, config.providers || {});
    var store = makeStore(config.storageKey || "tutorchat");
    var contextBuilder = config.contextBuilder || subject.contextBuilder || function(){ return ""; };

    var root = document.createElement("div");
    root.className = "tc-root";
    root.innerHTML =
      '<button class="tc-fab" aria-label="Open ' + escHtml(subject.name) + '" title="' + escHtml(subject.name) + '">✦</button>' +
      '<div class="tc-panel" role="dialog" aria-label="' + escHtml(subject.name) + '" aria-hidden="true">' +
      '  <div class="tc-head">' +
      '    <strong>' + escHtml(subject.name) + '</strong>' +
      '    <div>' +
      '      <button class="tc-icon" data-action="settings" title="Settings">⚙️</button>' +
      '      <button class="tc-icon" data-action="clear" title="Clear chat">⌫</button>' +
      '      <button class="tc-icon" data-action="close" title="Close">✕</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="tc-settings" hidden>' +
      '    <p class="tc-small tc-muted">Bring your own model. Your key is stored only in this browser.</p>' +
      '    <label class="tc-small tc-muted">Provider</label>' +
      '    <div class="tc-btnrow" data-role="presetRow">' +
      '      <button class="tc-btn" data-preset="gemini" type="button">Gemini</button>' +
      '      <button class="tc-btn" data-preset="local" type="button">Local</button>' +
      '      <button class="tc-btn" data-preset="custom" type="button">Custom</button>' +
      '    </div>' +
      '    <input class="tc-field" data-role="baseUrl" placeholder="Base URL">' +
      '    <input class="tc-field" data-role="model" placeholder="Model">' +
      '    <input class="tc-field" data-role="apiKey" type="password" placeholder="API key (blank for local)">' +
      '    <label class="tc-small tc-muted tc-checkrow"><input type="checkbox" data-role="searchOn"> Enable web search (local only)</label>' +
      '    <input class="tc-field" data-role="bridgeUrl" placeholder="Search bridge URL">' +
      '    <label class="tc-small tc-muted tc-checkrow"><input type="checkbox" data-role="fixThinking"> 🧠 Fix thinking model (cuts reasoning time on local reasoning models e.g. Qwen3)</label>' +
      '    <div class="tc-btnrow"><button class="tc-btn" data-role="test" type="button">Test connection</button></div>' +
      '    <p class="tc-small" data-role="testOut"></p>' +
      '  </div>' +
      '  <div class="tc-log"></div>' +
      '  <form class="tc-inputrow">' +
      '    <input class="tc-text" placeholder="Ask a question…" autocomplete="off">' +
      '    <button class="tc-btn tc-btn--primary" type="submit">Send</button>' +
      '  </form>' +
      '</div>';
    container.appendChild(root);

    var fab = root.querySelector(".tc-fab");
    var panel = root.querySelector(".tc-panel");
    var settingsBox = root.querySelector(".tc-settings");
    var log = root.querySelector(".tc-log");
    var form = root.querySelector(".tc-inputrow");
    var textInput = root.querySelector(".tc-text");
    var presetRow = root.querySelector('[data-role="presetRow"]');
    var fields = {
      baseUrl: root.querySelector('[data-role="baseUrl"]'),
      model: root.querySelector('[data-role="model"]'),
      apiKey: root.querySelector('[data-role="apiKey"]'),
      searchOn: root.querySelector('[data-role="searchOn"]'),
      bridgeUrl: root.querySelector('[data-role="bridgeUrl"]'),
      fixThinking: root.querySelector('[data-role="fixThinking"]')
    };
    var testBtn = root.querySelector('[data-role="test"]');
    var testOut = root.querySelector('[data-role="testOut"]');

    var chatBusy = false;

    function escHtml(s){
      return String(s).replace(/[&<>"']/g, function(c){
        return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
      });
    }

    function isAIConfigured(){
      var cfg = store.getConfig();
      var preset = resolvePreset(presets, cfg.preset);
      if(!preset) return false;
      if(preset.needsKey && !cfg.apiKey) return false;
      if(!cfg.baseUrl || !cfg.model) return false;
      return true;
    }

    function chatMsgEl(role, text){
      var el = document.createElement("div");
      el.className = "tc-msg " + role;
      el.textContent = text;
      return el;
    }

    function renderHistory(){
      log.innerHTML = "";
      store.getHistory().forEach(function(m){ log.appendChild(chatMsgEl(m.role, m.content)); });
      log.scrollTop = log.scrollHeight;
    }

    function openPanel(){
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
      renderHistory();
      setTimeout(function(){ textInput.focus(); }, 60);
    }
    function closePanel(){
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      fab.focus();
    }

    async function sendChat(text){
      if(chatBusy || !text.trim()) return;
      if(!isAIConfigured()){
        var msg = chatMsgEl("error", "⚙️ Not configured yet. Click the settings icon (⚙️) to set up your AI provider.");
        log.appendChild(msg); log.scrollTop = log.scrollHeight;
        return;
      }
      chatBusy = true;
      var cfg = store.getConfig();

      store.pushMessage({ role: "user", content: text, ts: Date.now() });
      log.appendChild(chatMsgEl("user", text));

      var sys = buildSystemPrompt(subject.systemTemplate, contextBuilder());
      if(cfg.fixThinking) sys = sys + "\n\n" + THINKING_FIX_HINT;
      var messages = buildMessages(sys, store.getHistory().slice(0, -1).filter(function(m){ return m.role !== "error"; }), text);

      var preset = resolvePreset(presets, cfg.preset);
      var useSearch = !!cfg.searchOn && preset.canSearch;

      var acc = "";
      var bubble = chatMsgEl("assistant", "…");
      log.appendChild(bubble); log.scrollTop = log.scrollHeight;

      var opts = { onToken: function(t){ acc += t; bubble.textContent = acc; log.scrollTop = log.scrollHeight; } };
      if(useSearch){
        opts.tools = [{ type: "function", function: { name: "web_search",
          description: "Search the web for current information.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }];
        opts.runTool = async function(name, args){
          if(name !== "web_search") return "";
          try{
            var q = encodeURIComponent(args.query || "");
            var u = cfg.bridgeUrl + (cfg.bridgeUrl.indexOf("?") >= 0 ? "&" : "?") + "q=" + q;
            var r = await fetch(u, { mode: "cors", headers: { "Accept": "application/json" } });
            var json = await r.json();
            return normalizeSearchResults(json).map(function(x){ return "- " + x.title + ": " + x.snippet + " (" + x.url + ")"; }).join("\n") || "No results.";
          }catch(e){ return "Search bridge unreachable."; }
        };
      }

      try{
        var reply = await createClient(cfg).complete(messages, opts);
        var finalText = acc || reply || "(no response)";
        bubble.textContent = finalText;
        store.pushMessage({ role: "assistant", content: finalText, ts: Date.now() });
      }catch(err){
        bubble.className = "tc-msg error";
        bubble.textContent = (err && err.message) ? err.message : "Something went wrong.";
      }finally{
        chatBusy = false;
      }
    }

    function paintSettings(){
      var c = store.getConfig();
      var r = resolvePreset(presets, c.preset || "gemini");
      fields.baseUrl.value = c.baseUrl || r.baseUrl;
      fields.model.value = c.model || r.model;
      fields.apiKey.value = c.apiKey || "";
      fields.searchOn.checked = !!c.searchOn && r.canSearch;
      fields.searchOn.disabled = !r.canSearch;
      fields.bridgeUrl.value = c.bridgeUrl || "";
      fields.fixThinking.checked = !!c.fixThinking;
      Array.prototype.forEach.call(presetRow.children, function(b){
        b.classList.toggle("tc-btn--active", b.dataset.preset === c.preset);
      });
    }

    presetRow.querySelectorAll("button").forEach(function(b){
      b.onclick = function(){
        var preset = b.dataset.preset;
        var r = resolvePreset(presets, preset);
        store.setConfig({ preset: preset, baseUrl: r.baseUrl, model: r.model, searchOn: r.canSearch ? store.getConfig().searchOn : false });
        paintSettings();
      };
    });
    fields.baseUrl.onchange = function(){ store.setConfig({ baseUrl: fields.baseUrl.value.trim() }); };
    fields.model.onchange = function(){ store.setConfig({ model: fields.model.value.trim() }); };
    fields.apiKey.onchange = function(){ store.setConfig({ apiKey: fields.apiKey.value }); };
    fields.searchOn.onchange = function(){ store.setConfig({ searchOn: fields.searchOn.checked }); };
    fields.bridgeUrl.onchange = function(){ store.setConfig({ bridgeUrl: fields.bridgeUrl.value.trim() }); };
    fields.fixThinking.onchange = function(){ store.setConfig({ fixThinking: fields.fixThinking.checked }); };

    testBtn.onclick = async function(){
      testOut.textContent = "Testing…"; testOut.className = "tc-small";
      testBtn.disabled = true;
      try{
        var c = store.getConfig();
        var baseUrl = (c.baseUrl || "").replace(/\/?$/, "/");
        try{
          var preflight = await fetch(baseUrl, { method: "OPTIONS" }).catch(function(){ return null; });
          if(!preflight && baseUrl.indexOf("localhost") >= 0){
            testOut.textContent = "✗ Server unreachable. Is your local server running on " + baseUrl + "?";
            testOut.className = "tc-small tc-error-text";
            return;
          }
        }catch(e){}
        var client = createClient(c);
        var reply = await client.complete(
          [{ role: "system", content: "Reply with the single word OK." }, { role: "user", content: "ping" }], {});
        testOut.textContent = "✓ Connected. Model replied: " + String(reply).slice(0, 40);
        testOut.className = "tc-small tc-ok-text";
      }catch(err){
        testOut.textContent = "✗ " + (err && err.message ? err.message : "Failed");
        testOut.className = "tc-small tc-error-text";
      }finally{
        testBtn.disabled = false;
      }
    };

    fab.onclick = openPanel;
    root.querySelector('[data-action="close"]').onclick = closePanel;
    root.querySelector('[data-action="clear"]').onclick = function(){
      if(confirm("Clear this conversation?")){ store.clearHistory(); renderHistory(); }
    };
    root.querySelector('[data-action="settings"]').onclick = function(){
      settingsBox.hidden = !settingsBox.hidden;
      if(!settingsBox.hidden) paintSettings();
    };
    form.onsubmit = function(e){ e.preventDefault(); var v = textInput.value; textInput.value = ""; sendChat(v); };
    document.addEventListener("keydown", function(e){
      if(e.key === "Escape" && panel.classList.contains("open")) closePanel();
    });

    paintSettings();

    return { open: openPanel, close: closePanel, destroy: function(){ root.remove(); } };
  }

  return {
    mount: mount,
    resolvePreset: resolvePreset,
    buildSystemPrompt: buildSystemPrompt,
    buildMessages: buildMessages,
    classifyError: classifyError,
    normalizeSearchResults: normalizeSearchResults,
    createClient: createClient,
    DEFAULT_PRESETS: DEFAULT_PRESETS,
    THINKING_FIX_HINT: THINKING_FIX_HINT
  };
})();
