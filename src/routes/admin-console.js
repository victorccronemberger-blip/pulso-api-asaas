// Console administrativo standalone de ativacao manual de matriculas. Servido pelo
// proprio backend (mesma origem dos cookies de sessao admin), sem build/frontend
// externo: quando a matricula automatica de um cliente falha, o operador loga aqui
// e ativa com um botao. Usa as rotas oficiais de ativacao (course-activations) e
// dispara o MESMO fluxo validado via fila (queue.enqueueManualActivation).

const PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PULSO - Ativacao de Curso</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #9aa0aa; font-size: 13px; margin-bottom: 24px; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  label { display: block; font-size: 13px; color: #9aa0aa; margin: 12px 0 4px; }
  input, select { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2c3340; background: #0f1115; color: #e6e6e6; font-size: 14px; }
  button { cursor: pointer; border: 0; border-radius: 8px; padding: 11px 18px; font-size: 14px; font-weight: 600; background: #2563eb; color: #fff; margin-top: 16px; }
  button.secondary { background: #2c3340; color: #e6e6e6; }
  button:disabled { opacity: .55; cursor: wait; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 220px; }
  .status { margin-top: 16px; padding: 14px; border-radius: 8px; font-size: 14px; display: none; white-space: pre-wrap; word-break: break-word; }
  .status.ok { display: block; background: #06281c; border: 1px solid #14532d; color: #4ade80; }
  .status.err { display: block; background: #2a0d0d; border: 1px solid #7f1d1d; color: #f87171; }
  .status.wait { display: block; background: #101a2e; border: 1e3a8a; border: 1px solid #1e3a8a; color: #93c5fd; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #232833; }
  th { color: #9aa0aa; font-weight: 600; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .pill.confirmed { background: #14532d; color: #4ade80; }
  .pill.failed, .pill.not_created { background: #7f1d1d; color: #f87171; }
  .pill.pending, .pill.queued, .pill.processing { background: #1e3a8a; color: #93c5fd; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .muted { color: #6b7280; font-size: 12px; }
  .courses { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 14px; margin-top: 8px; max-height: 240px; overflow: auto; padding: 6px; border: 1px solid #232833; border-radius: 8px; }
  .courses label { display: flex; align-items: center; gap: 8px; margin: 0; color: #e6e6e6; font-size: 13px; }
  .courses input { width: auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div class="top">
    <div>
      <h1>Ativacao manual de curso</h1>
      <div class="sub">PULSO &middot; rede de seguranca quando a matricula automatica falha</div>
    </div>
    <button class="secondary" id="logout" hidden>Sair</button>
  </div>

  <div class="card" id="login">
    <label>Email do administrador</label>
    <input id="login-email" type="email" autocomplete="username">
    <label>Senha</label>
    <input id="login-pass" type="password" autocomplete="current-password">
    <button id="login-btn">Entrar</button>
    <div class="status" id="login-status"></div>
  </div>

  <div id="panel" hidden>
    <div class="card">
      <div class="muted" id="who"></div>
      <form id="form">
        <label>Cliente (busque pelo email)</label>
        <input id="customer-search" placeholder="digite para filtrar..." autocomplete="off">
        <select id="customer" size="6" style="margin-top:8px"></select>
        <div class="row">
          <div>
            <label>Nome completo do aluno <span class="muted">(vazio = usa o do pedido pago)</span></label>
            <input id="fullname" placeholder="nome completo">
          </div>
          <div>
            <label>CPF / CNPJ <span class="muted">(vazio = puxa do pedido pago)</span></label>
            <input id="doc" placeholder="somente numeros" inputmode="numeric">
          </div>
        </div>
        <label>Cursos a ativar</label>
        <div class="courses" id="courses"></div>
        <button type="submit" id="activate-btn">Ativar matricula(s)</button>
      </form>
      <div class="status" id="status"></div>
    </div>

    <div class="card">
      <h1 style="font-size:16px">Ativacoes recentes</h1>
      <table>
        <thead><tr><th>Curso</th><th>Email</th><th>Turma</th><th>Status</th><th>Quando</th></tr></thead>
        <tbody id="recent"></tbody>
      </table>
    </div>
  </div>
</main>
<script>
var csrf = null;
var allCustomers = [];
function $(id) { return document.getElementById(id); }
function show(el, cls, msg) { el.className = "status " + cls; el.textContent = msg; }
function hide(el) { el.className = "status"; el.textContent = ""; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function api(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.credentials = "same-origin";
  if (opts.body) { opts.headers["Content-Type"] = "application/json"; }
  if (csrf && opts.method && opts.method !== "GET") { opts.headers["X-CSRF-Token"] = csrf; }
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
  });
}
function onlyDigits(v) { return (v || "").replace(/\\D/g, ""); }

function renderCustomers(filter) {
  var sel = $("customer");
  sel.innerHTML = "";
  var f = (filter || "").toLowerCase();
  allCustomers.filter(function (c) { return !f || (c.email || "").toLowerCase().indexOf(f) >= 0 || (c.displayName || "").toLowerCase().indexOf(f) >= 0; })
    .slice(0, 200)
    .forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.email + "  |  " + (c.displayName || "(sem nome)") + "  |  ativas: " + (c.activationCount || 0);
      o.dataset.name = c.displayName || "";
      sel.appendChild(o);
    });
}
function selectedCustomer() {
  var sel = $("customer");
  var opt = sel.options[sel.selectedIndex];
  return opt ? { id: opt.value, name: opt.dataset.name || "" } : null;
}
$("customer").addEventListener("change", function () {
  var c = selectedCustomer();
  if (c && c.name && !$("fullname").value) { $("fullname").value = c.name; }
});
$("customer-search").addEventListener("input", function () { renderCustomers(this.value); });

function refresh() {
  return api("/v1/admin/session").then(function (res) {
    var auth = res.status === 200 && res.body && res.body.authenticated;
    $("login").hidden = auth;
    $("panel").hidden = !auth;
    $("logout").hidden = !auth;
    if (auth) {
      csrf = res.body.csrfToken;
      $("who").textContent = "Sessao: " + (res.body.admin && res.body.admin.email);
      loadProducts();
      loadCustomers();
      loadRecent();
    }
  });
}
function loadCustomers() {
  api("/v1/admin/customers?limit=200").then(function (res) {
    allCustomers = (res.body && res.body.customers) || [];
    renderCustomers("");
  });
}
function loadProducts() {
  api("/v1/admin/products").then(function (res) {
    var box = $("courses");
    box.innerHTML = "";
    var items = (res.body && res.body.products) || [];
    items.forEach(function (p) {
      var l = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p.slug;
      l.appendChild(cb);
      l.appendChild(document.createTextNode(p.title));
      box.appendChild(l);
    });
  });
}
function loadRecent() {
  api("/v1/admin/enrollments?limit=15").then(function (res) {
    var tb = $("recent");
    tb.innerHTML = "";
    var items = (res.body && res.body.enrollments) || [];
    items.forEach(function (e) {
      var tr = document.createElement("tr");
      var when = e.createdAt ? new Date(e.createdAt).toLocaleString("pt-BR") : "-";
      tr.innerHTML =
        "<td>" + esc(e.courseSlug) + "</td>" +
        "<td>" + esc(e.buyerEmail) + "</td>" +
        "<td>" + esc(e.idTurma || "-") + "</td>" +
        '<td><span class="pill ' + esc(e.status) + '">' + esc(e.status) + "</span></td>" +
        "<td class='muted'>" + esc(when) + "</td>";
      tb.appendChild(tr);
    });
  });
}
function pollJob(id, attempts) {
  attempts = attempts || 0;
  return api("/v1/admin/enrollments/" + id).then(function (res) {
    var e = res.body && res.body.enrollment;
    if (!e) { return "gone"; }
    if (e.status === "confirmed") { return "confirmed:" + (e.idTurma || "?"); }
    if (e.status === "failed" || e.status === "not_created") { return "failed:" + (e.error || e.status); }
    if (attempts > 120) { return "timeout:" + e.status; }
    return "wait:" + e.status;
  }).then(function (state) {
    if (state.indexOf("wait") === 0) {
      setTimeout(function () { pollJob(id, attempts + 1).then(function () { aggregate(); }); }, 3000);
    }
    jobStates[id] = state;
    aggregate();
    return state;
  });
}
var jobStates = {};
function aggregate() {
  var ids = Object.keys(jobStates);
  if (!ids.length) return;
  var done = ids.every(function (id) { return jobStates[id].indexOf("wait") !== 0; });
  var lines = ids.map(function (id) { return id.slice(0, 8) + ": " + jobStates[id]; });
  if (!done) {
    show($("status"), "wait", "Processando na plataforma ART...\\n" + lines.join("\\n"));
  } else {
    var allOk = ids.every(function (id) { return jobStates[id].indexOf("confirmed") === 0; });
    show($("status"), allOk ? "ok" : "err", (allOk ? "MATRICULA(S) CONFIRMADA(S)\\n" : "CONCLUIDO COM PENDENCIAS\\n") + lines.join("\\n"));
    $("activate-btn").disabled = false;
    loadRecent();
    loadCustomers();
  }
}

$("login-btn").addEventListener("click", function () {
  hide($("login-status"));
  api("/v1/admin/login", { method: "POST", body: JSON.stringify({ email: $("login-email").value.trim(), password: $("login-pass").value }) })
    .then(function (res) {
      if (res.status === 200 && res.body.authenticated) { refresh(); }
      else { show($("login-status"), "err", "Credenciais invalidas."); }
    });
});
$("logout").addEventListener("click", function () {
  api("/v1/admin/logout", { method: "POST", body: "{}" }).then(function () { csrf = null; refresh(); });
});
$("form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  hide($("status"));
  var customer = selectedCustomer();
  if (!customer) { show($("status"), "err", "Selecione um cliente na lista."); return; }
  var courseSlugs = Array.prototype.slice.call(document.querySelectorAll("#courses input:checked")).map(function (cb) { return cb.value; });
  if (!courseSlugs.length) { show($("status"), "err", "Selecione ao menos um curso."); return; }
  $("activate-btn").disabled = true;
  jobStates = {};
  var payload = {
    customerId: customer.id,
    fullName: $("fullname").value.trim(),
    documentNumber: onlyDigits($("doc").value),
    courseSlugs: courseSlugs,
  };
  api("/v1/admin/course-activations", { method: "POST", body: JSON.stringify(payload) })
    .then(function (res) {
      if (res.status === 201 && res.body.activation) {
        var ids = res.body.activation.enrollmentIds || [];
        var skipped = res.body.activation.skipped || [];
        var msg = "Ativacao iniciada: " + ids.length + " job(s).";
        if (res.body.activation.buyer) {
          msg += " Aluno: " + res.body.activation.buyer.fullName + " (doc ***" + res.body.activation.buyer.documentLast4 + (res.body.activation.buyer.fromOrder ? ", do pedido pago" : "") + ").";
        }
        if (skipped.length) { msg += "\\nIgnorados: " + JSON.stringify(skipped); }
        show($("status"), "wait", msg);
        if (!ids.length) { $("activate-btn").disabled = false; return; }
        ids.forEach(function (id) { jobStates[id] = "wait:queued"; pollJob(id); });
        aggregate();
      } else {
        var detail = (res.body && (res.body.message || res.body.error)) || JSON.stringify(res.body).slice(0, 400);
        show($("status"), "err", "Erro (" + res.status + "): " + detail);
        $("activate-btn").disabled = false;
      }
    });
});
refresh();
</script>
</body>
</html>`;

export function createAdminConsoleRouter(express) {
  const router = express.Router();
  router.get("/", (_request, response) => {
    // Sobrescreve o CSP do helmet para permitir o JS/CSS inline desta pagina
    // admin interna (autenticada, mesma origem da API).
    response.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    response.set("Content-Type", "text/html; charset=utf-8");
    response.send(PAGE_HTML);
  });
  return router;
}
