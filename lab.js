// ── LAB PANEL (safe sandbox + learning) ──────────────────────────────────────
let labActiveTab = 'playground'; // 'playground' | 'python' | 'learn'
let pyodideReady = false;

function renderLab(){
  // Header
  const head = document.createElement('div');
  head.style.cssText = 'padding:16px 16px 8px;border-bottom:1px solid var(--border)';
  head.innerHTML =
    '<div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:2px">Lab</div>' +
    '<div style="font-size:11.5px;color:var(--text-3);line-height:1.4">Play with code safely — everything runs in your browser sandbox.</div>';
  sidebarContent.appendChild(head);

  // Tab bar
  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;gap:1px;padding:8px 8px 0;background:var(--bg);border-bottom:1px solid var(--border)';
  ['playground', 'python', 'learn'].forEach(id => {
    const labels = { playground: 'JS + HTML', python: 'Python', learn: 'Learn' };
    const b = document.createElement('button');
    b.className = 'lab-tab' + (labActiveTab === id ? ' active' : '');
    b.textContent = labels[id];
    b.onclick = () => { labActiveTab = id; renderLab(); };
    tabs.appendChild(b);
  });
  sidebarContent.appendChild(tabs);

  // Body
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:14px 14px;font-size:12.5px;color:var(--text)';

  if (labActiveTab === 'playground') {
    // JS + HTML + CSS playground
    body.innerHTML =
      '<div style="font-size:11px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">HTML</div>' +
      '<textarea id="labHtml" style="width:100%;height:90px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:var(--font-mono);font-size:12px;resize:vertical">&lt;h1&gt;Hi from Lizzy&lt;/h1&gt;\n&lt;p&gt;Edit me -&gt; press Run&lt;/p&gt;\n&lt;button&gt;Click me&lt;/button&gt;</textarea>' +
      '<div style="font-size:11px;color:var(--text-3);margin:14px 0 6px;text-transform:uppercase;letter-spacing:0.5px">CSS</div>' +
      '<textarea id="labCss" style="width:100%;height:60px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:var(--font-mono);font-size:12px;resize:vertical">h1 { color: #E05C2A; text-align: center; }\nbutton { background: #161616; color: white; padding: 8px 16px; border-radius: 6px; }</textarea>' +
      '<div style="font-size:11px;color:var(--text-3);margin:14px 0 6px;text-transform:uppercase;letter-spacing:0.5px">JavaScript</div>' +
      '<textarea id="labJs" style="width:100%;height:80px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:var(--font-mono);font-size:12px;resize:vertical">document.querySelector(\'button\').onclick = () =&gt; alert(\'Hi!\');</textarea>' +
      '<button class="btn-3d-accent" id="labRunBtn" style="margin-top:12px;width:100%">▶ Run preview</button>' +
      '<div style="margin-top:12px;border:1px solid var(--border);border-radius:6px;min-height:200px;background:#fff;overflow:hidden;position:relative">' +
      '<div style="background:#f0f0f0;padding:4px 8px;font-size:10px;color:#666;border-bottom:1px solid #ddd">preview</div>' +
      '<iframe id="labFrame" sandbox="allow-scripts" style="width:100%;height:240px;border:none;display:block;background:#fff"></iframe></div>' +
      '<div style="margin-top:8px;font-size:10.5px;color:var(--text-3)">Sandbox: iframe sandboxed — scripts cannot reach the network by default.</div>';

    sidebarContent.appendChild(body);
    setTimeout(() => {
      const btn = document.getElementById('labRunBtn');
      if (btn) btn.onclick = () => {
        const html = document.getElementById('labHtml').value;
        const css = document.getElementById('labCss').value;
        const js = document.getElementById('labJs').value;
        const fullHtml = '<style>' + css + '</style>' + html + '<script>try{' + js + '}catch(e){console.error(e)}</script>';
        document.getElementById('labFrame').srcdoc = fullHtml;
      };
    }, 50);
  } else if (labActiveTab === 'python') {
    body.innerHTML =
      '<div style="font-size:11px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Python (via Pyodide, runs in browser)</div>' +
      '<div id="pyStatus" style="font-size:11.5px;color:var(--text-3);padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:8px">Click Load to download Python (~25MB, one time)</div>' +
      '<button id="pyLoad" class="btn-3d-accent" style="margin-bottom:10px;width:100%">⬇ Load Python</button>' +
      '<textarea id="pyCode" style="width:100%;height:140px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:var(--font-mono);font-size:12px;resize:vertical">print("Hello from Python!")\nfor i in range(3):\n    print(f"Count: {i+1}")\nprint(2 + 2)</textarea>' +
      '<button id="pyRun" class="btn-3d" style="margin-top:10px;width:100%" disabled>▶ Run (load Python first)</button>' +
      '<div style="margin-top:14px;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px">Output</div>' +
      '<pre id="pyOut" style="background:#000;color:#4ade80;padding:10px;border-radius:6px;font-size:12px;font-family:var(--font-mono);min-height:80px;white-space:pre-wrap;margin:6px 0 0"></pre>' +
      '<div style="margin-top:8px;font-size:10.5px;color:var(--text-3)">Runs Python 3 entirely in your browser via WebAssembly. Nothing touches the server.</div>';

    sidebarContent.appendChild(body);
    setTimeout(() => {
      const loadBtn = document.getElementById('pyLoad');
      if (!loadBtn) return;
      loadBtn.onclick = async () => {
        const status = document.getElementById('pyStatus');
        status.textContent = 'Downloading Python runtime...';
        try {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js';
          document.head.appendChild(script);
          await new Promise((r, j) => { script.onload = r; script.onerror = j; });
          status.textContent = 'Initializing Python interpreter...';
          window.pyodide = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/' });
          pyodideReady = true;
          status.textContent = '✓ Python ready — write code above and press Run';
          status.style.color = '#4ade80';
          const runBtn = document.getElementById('pyRun');
          runBtn.disabled = false;
          runBtn.textContent = '▶ Run Python';
          loadBtn.disabled = true;
          loadBtn.textContent = '✓ Loaded';
          runBtn.onclick = async () => {
            const code = document.getElementById('pyCode').value;
            const out = document.getElementById('pyOut');
            out.textContent = '';
            try {
              window.pyodide.setStdout({ batched: (s) => { out.textContent += s + '\n'; } });
              window.pyodide.setStderr({ batched: (s) => { out.textContent += s + '\n'; } });
              await window.pyodide.runPythonAsync(code);
            } catch (e) { out.textContent += 'Error: ' + e.message; }
          };
        } catch (e) {
          status.textContent = 'Failed to load Python: ' + e.message;
          status.style.color = '#f87171';
        }
      };
    }, 50);
  } else {
    // Learn tab
    const links = [
      ['TryHackMe', 'https://tryhackme.com', 'Beginner-friendly cybersecurity labs (free tier)'],
      ['PortSwigger Academy', 'https://portswigger.net/web-security', 'Free web-security training with hands-on labs'],
      ['pwn.college', 'https://pwn.college', 'Linux & computer security foundations'],
      ['OWASP Top 10', 'https://owasp.org/www-top-ten/', 'How web apps get attacked (defensive view)'],
      ['freeCodeCamp', 'https://www.freecodecamp.org', 'Web dev from scratch, free certifications'],
      ['MDN Web Docs', 'https://developer.mozilla.org', 'The web language reference'],
      ['Project-Based Learning', 'https://github.com/practical-tutorials/project-based-learning', '100+ build tutorials on GitHub'],
      ['First Contributions', 'https://github.com/firstcontributions/first-contributions', 'Your first GitHub pull request'],
      ['Exercism', 'https://exercism.org', 'Code practice in 60+ languages'],
      ['Build your own X', 'https://github.com/codecrafters-io/build-your-own-x', 'Build clones of real systems (DBs, Git, Redis...)'],
    ];
    body.innerHTML =
      '<div style="font-size:13px;color:var(--text-2);margin-bottom:12px;line-height:1.5">Curated, legal learning paths. Tap a card to open in a new tab.</div>' +
      '<div style="display:grid;gap:8px">' +
      links.map(([name, url, desc]) =>
        '<a href="' + url + '" target="_blank" rel="noopener" class="lab-link">' +
        '<div style="font-weight:600;color:var(--text);font-size:13px;margin-bottom:2px">' + esc(name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-3);line-height:1.4">' + esc(desc) + '</div>' +
        '</a>'
      ).join('') +
      '</div>' +
      '<div style="margin-top:14px;padding:10px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-2);line-height:1.5">' +
      '<strong style="color:var(--accent)">Lab motto:</strong> build cool things, learn how attacks work (so you can defend), never punch down. Ethical hacking = you have permission and you are not breaking things you do not own.' +
      '</div>';
    sidebarContent.appendChild(body);
  }
}

// Inject styles once
(function(){
  if (document.getElementById('lab-styles-injected')) return;
  const s = document.createElement('style');
  s.id = 'lab-styles-injected';
  s.textContent =
    '.lab-tab{flex:1;padding:8px 4px;font-family:var(--font);font-size:11.5px;font-weight:500;background:transparent;color:var(--text-3);border:none;border-bottom:2px solid transparent;cursor:pointer;transition:all .1s}' +
    '.lab-tab:hover{color:var(--text)}' +
    '.lab-tab.active{color:var(--text);border-bottom-color:var(--accent)}' +
    '.lab-link{display:block;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;color:var(--text);text-decoration:none;transition:border-color .1s,background .1s}' +
    '.lab-link:hover{border-color:var(--accent);background:var(--surface)}';
  document.head.appendChild(s);
})();
