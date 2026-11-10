(function(){
  "use strict";

  var EXAMPLE_SCHEMA = {
    tables: [
      { name:"customers", description:"Клиенты компании",
        columns:[
          {name:"id", type:"bigint", description:"Первичный ключ клиента"},
          {name:"full_name", type:"text", description:"ФИО клиента"},
          {name:"city", type:"text", description:"Город клиента"},
          {name:"created_at", type:"timestamp", description:"Дата регистрации"}
        ]},
      { name:"orders", description:"Заказы клиентов",
        columns:[
          {name:"id", type:"bigint", description:"Первичный ключ заказа"},
          {name:"customer_id", type:"bigint", description:"Ссылка на customers.id"},
          {name:"status", type:"text", description:"Статус: new, paid, shipped, cancelled"},
          {name:"total_amount", type:"numeric", description:"Сумма заказа в рублях"},
          {name:"created_at", type:"timestamp", description:"Дата оформления заказа"}
        ]},
      { name:"order_items", description:"Позиции внутри заказа",
        columns:[
          {name:"id", type:"bigint", description:"Первичный ключ позиции"},
          {name:"order_id", type:"bigint", description:"Ссылка на orders.id"},
          {name:"product_name", type:"text", description:"Название товара"},
          {name:"quantity", type:"integer", description:"Количество единиц"},
          {name:"price", type:"numeric", description:"Цена за единицу"}
        ]}
    ]
  };

  // Prepared result for EXAMPLE_SCHEMA, shown on first visit so the page demonstrates the service without an API call.
  var DEMO_QUESTION = "по каждому городу за последние 6 месяцев покажи выручку по месяцам, число покупателей и самый продаваемый товар, только города с выручкой больше 100 000 ₽";
  var DEMO_SQL = [
    "WITH monthly_revenue AS (",
    "    SELECT",
    "        c.city,",
    "        date_trunc('month', o.created_at) AS month,",
    "        SUM(o.total_amount) AS revenue,",
    "        COUNT(DISTINCT c.id) AS customer_count",
    "    FROM orders o",
    "    JOIN customers c ON c.id = o.customer_id",
    "    WHERE o.created_at >= CURRENT_DATE - INTERVAL '6 months'",
    "    GROUP BY c.city, month",
    "),",
    "top_product AS (",
    "    SELECT",
    "        c.city,",
    "        oi.product_name,",
    "        SUM(oi.quantity) AS total_quantity,",
    "        date_trunc('month', o.created_at) AS month",
    "    FROM order_items oi",
    "    JOIN orders o ON o.id = oi.order_id",
    "    JOIN customers c ON c.id = o.customer_id",
    "    WHERE o.created_at >= CURRENT_DATE - INTERVAL '6 months'",
    "    GROUP BY c.city, oi.product_name, month",
    "),",
    "ranked_products AS (",
    "    SELECT",
    "        tp.city,",
    "        tp.product_name,",
    "        tp.month,",
    "        ROW_NUMBER() OVER (PARTITION BY tp.city, tp.month ORDER BY tp.total_quantity DESC) AS rank",
    "    FROM top_product tp",
    ")",
    "SELECT",
    "    mr.city,",
    "    mr.month,",
    "    mr.revenue,",
    "    mr.customer_count,",
    "    rp.product_name AS top_product",
    "FROM monthly_revenue mr",
    "JOIN ranked_products rp ON rp.city = mr.city AND rp.month = mr.month",
    "WHERE mr.revenue > 100000 AND rp.rank = 1",
    "ORDER BY mr.city, mr.month;"
  ].join("\n");
  var DEMO_EXPLANATION = "Считает выручку и число уникальных покупателей по городам и месяцам за последние 6 месяцев (от сегодняшней даты), находит в каждом городе и месяце товар с наибольшим проданным количеством и оставляет только те строки, где выручка за месяц больше 100 000. Допущения: учитываются все заказы, включая отменённые; порог 100 000 применяется к выручке города за каждый месяц, а не к итогу за весь период.";

  var KEYS = {
    schema: "sqlverstak.schema",
    history: "sqlverstak.history",
    banner: "sqlverstak.bannerDismissed"
  };

  var state = {
    schema: null,
    selectedTables: [],
    history: [],
    abortCtl: null
  };

  var els = {
    schemaList: document.getElementById("schema-list"),
    tablesCountHint: document.getElementById("tables-count-hint"),
    addTableBtn: document.getElementById("add-table-btn"),
    banner: document.getElementById("banner"),
    bannerClose: document.getElementById("banner-close"),
    tablesSelect: document.getElementById("tables-select"),
    tablesHint: document.getElementById("tables-hint"),
    question: document.getElementById("question"),
    genBtn: document.getElementById("gen-btn"),
    stopBtn: document.getElementById("stop-btn"),
    status: document.getElementById("status"),
    codeWrap: document.getElementById("code-wrap"),
    copyBtn: document.getElementById("copy-btn"),
    explain: document.getElementById("explain"),
    historyList: document.getElementById("history-list")
  };

  function store(key, value){
    try{ localStorage.setItem(key, value); }catch(e){}
  }

  function load(key){
    try{ return localStorage.getItem(key); }catch(e){ return null; }
  }

  var saveTimer = null;
  function scheduleSave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      store(KEYS.schema, JSON.stringify(state.schema));
    }, 400);
  }

  function saveHistory(){
    state.history = state.history.slice(0, 50);
    store(KEYS.history, JSON.stringify(state.history));
  }

  function addHistory(entry){
    state.history.unshift(Object.assign({ id: String(Date.now()) }, entry));
    saveHistory();
    renderHistory();
  }

  function deleteHistory(id){
    state.history = state.history.filter(function(h){ return h.id !== id; });
    saveHistory();
    renderHistory();
  }

  var SQL_KEYWORDS = ["SELECT","DISTINCT","FROM","WHERE","GROUP BY","ORDER BY","HAVING","LIMIT",
    "OFFSET","JOIN","LEFT JOIN","RIGHT JOIN","INNER JOIN","OUTER JOIN","FULL JOIN","ON","AS",
    "AND","OR","NOT","IN","IS","NULL","INSERT INTO","VALUES","UPDATE","SET","DELETE","CREATE TABLE",
    "WITH","UNION ALL","UNION","CASE","WHEN","THEN","ELSE","END","BETWEEN","LIKE","ILIKE",
    "COUNT","SUM","AVG","MIN","MAX","DESC","ASC","OVER","PARTITION BY","EXISTS","COALESCE"];

  var SQL_HL_RE = (function(){
    var kwPattern = SQL_KEYWORDS
      .slice().sort(function(a,b){ return b.length - a.length; })
      .map(function(k){ return k.replace(/ /g, "\\s+"); })
      .join("|");
    return new RegExp(
      "(--[^\\n]*)" +
      "|('(?:[^']|'')*')" +
      "|\\b(" + kwPattern + ")\\b" +
      "|\\b(\\d+(?:\\.\\d+)?)\\b",
      "gi"
    );
  })();

  // Highlighting builds DOM nodes instead of HTML strings, so model output is never parsed as markup.
  function buildSqlNode(sql){
    var pre = document.createElement("pre");
    pre.className = "sql";
    var re = new RegExp(SQL_HL_RE.source, "gi");
    var lastIndex = 0, m;
    while((m = re.exec(sql)) !== null){
      if(m.index > lastIndex) pre.appendChild(document.createTextNode(sql.slice(lastIndex, m.index)));
      var span = document.createElement("span");
      if(m[1]){ span.className = "com"; span.textContent = m[1]; }
      else if(m[2]){ span.className = "str"; span.textContent = m[2]; }
      else if(m[3]){ span.className = "kw"; span.textContent = m[3].toUpperCase(); }
      else { span.className = "num"; span.textContent = m[4]; }
      pre.appendChild(span);
      lastIndex = re.lastIndex;
      if(m.index === re.lastIndex) re.lastIndex++;
    }
    if(lastIndex < sql.length) pre.appendChild(document.createTextNode(sql.slice(lastIndex)));
    return pre;
  }

  // Exact-cell-match labels (not substring) so a real column literally
  // called "full_name" or "type" in a data export never gets mistaken
  // for a schema-template header.
  var IMPORT_ROLE_LABELS = {
    name: ["имя","название","наименование","имя столбца","название столбца","столбец","колонка","поле","column","column name","field","field name","name"],
    type: ["тип","тип данных","type","data type","datatype"],
    description: ["описание","комментарий","назначение","desc","description","comment"]
  };

  function normalizeCell(v){
    return v === null || v === undefined ? "" : String(v).trim();
  }

  function guessColumnType(values){
    var seen = values.map(normalizeCell).filter(function(v){ return v; });
    if(seen.length === 0) return "";
    var boolLike = /^(true|false|да|нет|yes|no|0|1)$/i;
    var intLike = /^-?\d+$/;
    var numLike = /^-?\d+([.,]\d+)?$/;
    var dateLike = /^\d{1,4}[.\-\/]\d{1,2}[.\-\/]\d{1,4}$/;
    if(seen.every(function(v){ return boolLike.test(v); })) return "boolean";
    if(seen.every(function(v){ return dateLike.test(v); })) return "date";
    if(seen.every(function(v){ return intLike.test(v); })) return "integer";
    if(seen.every(function(v){ return numLike.test(v); })) return "numeric";
    return "text";
  }

  // Reads an .xlsx/.xls/.csv file and returns a Promise of column rows
  // {name, type, description}. Two shapes are recognized:
  //  1) A real table export: the first row holds the table's own column
  //     names left-to-right, with optional data rows below used only to
  //     guess each column's type.
  //  2) A schema-template sheet: a header row that exactly matches role
  //     labels like "Имя"/"Тип"/"Описание" (any order), one table column
  //     per data row underneath.
  // Shape 2 only fires when at least two roles are matched, so a genuine
  // data column named exactly "name" or "type" is never misread as a
  // template header.
  function parseColumnsFromSpreadsheet(file){
    return file.arrayBuffer().then(function(buf){
      var wb = XLSX.read(buf, { type: "array" });
      var sheetName = wb.SheetNames[0];
      if(!sheetName) throw new Error("в файле нет листов");
      var sheet = wb.Sheets[sheetName];
      var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false });
      rows = (rows || []).filter(function(r){ return r && r.length && r.some(function(c){ return normalizeCell(c); }); });
      if(rows.length === 0) throw new Error("файл пустой");

      function findRole(headerRow, labels){
        for(var i=0;i<headerRow.length;i++){
          var cell = normalizeCell(headerRow[i]).toLowerCase();
          if(cell && labels.indexOf(cell) >= 0) return i;
        }
        return -1;
      }

      var header = rows[0];
      var nameIdx = findRole(header, IMPORT_ROLE_LABELS.name);
      var typeIdx = findRole(header, IMPORT_ROLE_LABELS.type);
      var descIdx = findRole(header, IMPORT_ROLE_LABELS.description);
      var rolesMatched = (nameIdx>=0?1:0) + (typeIdx>=0?1:0) + (descIdx>=0?1:0);

      var cols;
      if(nameIdx >= 0 && rolesMatched >= 2){
        cols = rows.slice(1).map(function(r){
          return {
            name: normalizeCell(r[nameIdx]),
            type: typeIdx >= 0 ? normalizeCell(r[typeIdx]) : "",
            description: descIdx >= 0 ? normalizeCell(r[descIdx]) : ""
          };
        });
      } else {
        var dataRows = rows.slice(1);
        cols = header.map(function(cell, i){
          var sampleValues = dataRows.map(function(r){ return r[i]; });
          return {
            name: normalizeCell(cell),
            type: guessColumnType(sampleValues),
            description: ""
          };
        });
      }

      cols = cols.filter(function(c){ return c.name; });
      if(cols.length === 0) throw new Error("не нашлись названия столбцов");
      return cols;
    });
  }

  function renderSchema(){
    els.schemaList.innerHTML = "";
    state.schema.tables.forEach(function(t, i){
      els.schemaList.appendChild(buildTableCard(t, i));
    });
    var n = state.schema.tables.length;
    els.tablesCountHint.textContent = n + " " + pluralTables(n);
    renderTablesSelect();
  }

  function pluralTables(n){
    var mod10 = n % 10, mod100 = n % 100;
    if(mod10 === 1 && mod100 !== 11) return "таблица";
    if(mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "таблицы";
    return "таблиц";
  }

  function addTable(){
    state.schema.tables.push({ name:"", description:"", columns:[{name:"",type:"",description:""}] });
    state.selectedTables.push(state.schema.tables.length - 1);
    renderSchema();
    scheduleSave();
    var cards = els.schemaList.querySelectorAll(".table-card");
    var last = cards[cards.length-1];
    if(last){ last.scrollIntoView({behavior:"smooth", block:"nearest"}); }
  }

  function removeTable(i){
    if(state.schema.tables.length <= 1){
      state.schema.tables[0] = { name:"", description:"", columns:[{name:"",type:"",description:""}] };
    } else {
      state.schema.tables.splice(i, 1);
    }
    state.selectedTables = state.selectedTables
      .filter(function(x){ return x !== i; })
      .map(function(x){ return x > i ? x - 1 : x; });
    renderSchema();
    scheduleSave();
  }

  function countNamedColumns(t){
    return t.columns.filter(function(c){ return c.name; }).length;
  }

  function buildTableCard(t, i){
    var details = document.createElement("details");
    details.className = "table-card";
    details.open = i < 3 || !t.name;

    var summary = document.createElement("summary");
    var chevronSpan = document.createElement("span");
    chevronSpan.className = "chevron";
    chevronSpan.textContent = "▸";
    var tnameSpan = document.createElement("span");
    tnameSpan.className = "tname" + (t.name ? "" : " empty");
    tnameSpan.textContent = t.name ? t.name : "таблица "+(i+1)+" — без имени";
    var colcountSpan = document.createElement("span");
    colcountSpan.className = "colcount";
    colcountSpan.textContent = countNamedColumns(t) + " стб.";
    var delTableBtn = document.createElement("button");
    delTableBtn.type = "button"; delTableBtn.className = "rm-btn";
    delTableBtn.textContent = "×"; delTableBtn.title = "Удалить таблицу";
    var confirming = false;
    delTableBtn.addEventListener("click", function(ev){
      ev.preventDefault(); ev.stopPropagation();
      if(!t.name || confirming){
        removeTable(i);
        return;
      }
      confirming = true;
      delTableBtn.textContent = "точно?";
      delTableBtn.classList.add("confirming");
      setTimeout(function(){
        confirming = false;
        delTableBtn.textContent = "×";
        delTableBtn.classList.remove("confirming");
      }, 2500);
    });
    summary.appendChild(chevronSpan);
    summary.appendChild(tnameSpan);
    summary.appendChild(colcountSpan);
    summary.appendChild(delTableBtn);
    details.appendChild(summary);

    var body = document.createElement("div");
    body.className = "body";

    var nameLabel = document.createElement("label");
    nameLabel.className = "field";
    nameLabel.textContent = "Имя таблицы";
    body.appendChild(nameLabel);

    var nameInput = document.createElement("input");
    nameInput.type = "text"; nameInput.className = "mono";
    nameInput.value = t.name; nameInput.placeholder = "например, orders";
    nameInput.addEventListener("input", function(){
      t.name = nameInput.value;
      tnameSpan.textContent = t.name || ("таблица "+(i+1)+" — без имени");
      tnameSpan.classList.toggle("empty", !t.name);
      renderTablesSelect();
      scheduleSave();
    });
    body.appendChild(nameInput);

    var descLabel = document.createElement("label");
    descLabel.className = "field";
    descLabel.textContent = "Описание таблицы";
    body.appendChild(descLabel);

    var descInput = document.createElement("input");
    descInput.type = "text";
    descInput.value = t.description; descInput.placeholder = "коротко: что хранит таблица";
    descInput.addEventListener("input", function(){ t.description = descInput.value; scheduleSave(); });
    body.appendChild(descInput);

    var colsHeadRow = document.createElement("div");
    colsHeadRow.className = "cols-head-row";
    var colsLabel = document.createElement("label");
    colsLabel.className = "field";
    colsLabel.textContent = "Столбцы";
    var importBtn = document.createElement("button");
    importBtn.type = "button"; importBtn.className = "mini-btn";
    importBtn.textContent = "Загрузить из Excel";
    importBtn.title = "Файл .xlsx/.xls/.csv: первая строка — обычная шапка таблицы (названия столбцов слева направо, как в выгрузке), тип определится по данным ниже. Либо шаблон с колонками \"Имя\"/\"Тип\"/\"Описание\".";
    var fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.accept = ".xlsx,.xls,.csv"; fileInput.hidden = true;
    colsHeadRow.appendChild(colsLabel);
    colsHeadRow.appendChild(importBtn);
    body.appendChild(colsHeadRow);
    body.appendChild(fileInput);

    var importStatus = document.createElement("div");
    importStatus.className = "import-status";
    importStatus.hidden = true;
    body.appendChild(importStatus);

    importBtn.addEventListener("click", function(){ fileInput.click(); });
    fileInput.addEventListener("change", function(){
      var file = fileInput.files && fileInput.files[0];
      if(!file) return;
      importStatus.hidden = false;
      importStatus.className = "import-status";
      importStatus.textContent = "Читаю файл…";
      if(typeof XLSX === "undefined"){
        importStatus.className = "import-status err";
        importStatus.textContent = "Библиотека для чтения Excel не загрузилась — проверьте интернет-соединение и попробуйте снова.";
        fileInput.value = "";
        return;
      }
      parseColumnsFromSpreadsheet(file).then(function(cols){
        t.columns = cols;
        renderCols();
        colcountSpan.textContent = countNamedColumns(t) + " стб.";
        importStatus.className = "import-status ok";
        importStatus.textContent = "Импортировано столбцов: " + cols.length + ". Проверьте и при необходимости поправьте типы/описания.";
        scheduleSave();
      }).catch(function(err){
        importStatus.className = "import-status err";
        importStatus.textContent = "Не удалось прочитать файл: " + (err && err.message ? err.message : "неизвестная ошибка");
      }).finally(function(){
        fileInput.value = "";
      });
    });

    var colsTable = document.createElement("table");
    colsTable.className = "cols-table";
    colsTable.innerHTML = "<thead><tr><th>Имя</th><th>Тип</th><th>Описание</th><th></th></tr></thead>";
    var tbody = document.createElement("tbody");
    colsTable.appendChild(tbody);
    body.appendChild(colsTable);

    function renderCols(){
      tbody.innerHTML = "";
      t.columns.forEach(function(c, ci){
        var tr = document.createElement("tr");

        var tdName = document.createElement("td"); tdName.className = "name";
        var nInp = document.createElement("input"); nInp.type="text"; nInp.className="name-input";
        nInp.value = c.name; nInp.placeholder="id";
        nInp.addEventListener("input", function(){
          c.name = nInp.value;
          colcountSpan.textContent = countNamedColumns(t) + " стб.";
          scheduleSave();
        });
        tdName.appendChild(nInp); tr.appendChild(tdName);

        var tdType = document.createElement("td"); tdType.className = "type";
        var tyInp = document.createElement("input"); tyInp.type="text"; tyInp.className="mono";
        tyInp.value = c.type; tyInp.placeholder="text";
        tyInp.addEventListener("input", function(){ c.type = tyInp.value; scheduleSave(); });
        tdType.appendChild(tyInp); tr.appendChild(tdType);

        var tdDesc = document.createElement("td"); tdDesc.className = "desc";
        var dInp = document.createElement("input"); dInp.type="text";
        dInp.value = c.description; dInp.placeholder="что означает столбец";
        dInp.addEventListener("input", function(){ c.description = dInp.value; scheduleSave(); });
        tdDesc.appendChild(dInp); tr.appendChild(tdDesc);

        var tdRm = document.createElement("td"); tdRm.className = "rm";
        var rmBtn = document.createElement("button"); rmBtn.type="button"; rmBtn.className="rm-btn";
        rmBtn.textContent = "×"; rmBtn.title = "Удалить столбец";
        rmBtn.addEventListener("click", function(){
          t.columns.splice(ci,1);
          if(t.columns.length===0) t.columns.push({name:"",type:"",description:""});
          renderCols();
          colcountSpan.textContent = countNamedColumns(t) + " стб.";
          scheduleSave();
        });
        tdRm.appendChild(rmBtn); tr.appendChild(tdRm);

        tbody.appendChild(tr);
      });
    }
    renderCols();

    var addBtn = document.createElement("button");
    addBtn.type = "button"; addBtn.className = "add-col-btn";
    addBtn.textContent = "+ Добавить столбец";
    addBtn.addEventListener("click", function(){
      t.columns.push({name:"",type:"",description:""});
      renderCols();
    });
    body.appendChild(addBtn);

    details.appendChild(body);
    return details;
  }

  function renderTablesSelect(){
    els.tablesSelect.innerHTML = "";
    var any = false;
    state.schema.tables.forEach(function(t, i){
      if(!t.name) return;
      any = true;
      var chip = document.createElement("span");
      chip.className = "chip" + (state.selectedTables.indexOf(i)>=0 ? " on" : "");
      chip.textContent = t.name;
      chip.addEventListener("click", function(){
        var idx = state.selectedTables.indexOf(i);
        if(idx>=0) state.selectedTables.splice(idx,1); else state.selectedTables.push(i);
        renderTablesSelect();
      });
      els.tablesSelect.appendChild(chip);
    });
    els.tablesHint.textContent = any ? "" : "сначала заполните схему слева";
  }

  function renderHistory(){
    els.historyList.innerHTML = "";
    if(state.history.length===0){
      var empty = document.createElement("div");
      empty.className = "empty-out";
      empty.textContent = "Пока пусто — здесь будут ваши прошлые запросы";
      els.historyList.appendChild(empty);
      return;
    }
    state.history.forEach(function(h){
      var row = document.createElement("div");
      row.className = "hist-item";
      var left = document.createElement("div");
      left.style.flex = "1"; left.style.minWidth = "0";
      var q = document.createElement("div"); q.className="q"; q.textContent = h.question;
      var meta = document.createElement("div"); meta.className="meta";
      meta.textContent = new Date(h.createdAt).toLocaleString("ru-RU");
      left.appendChild(q); left.appendChild(meta);
      row.appendChild(left);

      var del = document.createElement("button");
      del.className = "del"; del.type="button"; del.textContent = "×";
      del.title = "Удалить из истории";
      del.addEventListener("click", function(ev){
        ev.stopPropagation();
        deleteHistory(h.id);
      });
      row.appendChild(del);

      row.addEventListener("click", function(){
        els.question.value = h.question;
        showResult(h.sql, h.explanation);
      });
      els.historyList.appendChild(row);
    });
  }

  function showEmptyResult(){
    els.codeWrap.innerHTML = '<div class="empty-out">Здесь появится сгенерированный SQL-запрос</div>';
  }

  function showResult(sql, explanation){
    els.codeWrap.innerHTML = "";
    els.codeWrap.appendChild(buildSqlNode(sql));
    els.copyBtn.hidden = false;
    els.explain.textContent = explanation || "";
  }

  function setStatus(text, kind){
    els.status.className = "status-line" + (kind==="err" ? " err" : "");
    els.status.innerHTML = "";
    if(kind==="loading"){
      var dot = document.createElement("span"); dot.className="dot";
      els.status.appendChild(dot);
    }
    var span = document.createElement("span");
    span.textContent = text;
    els.status.appendChild(span);
  }

  function buildTablesPayload(){
    return state.schema.tables
      .filter(function(t, i){ return t.name && state.selectedTables.indexOf(i)>=0; })
      .map(function(t){
        return {
          name: t.name,
          description: t.description,
          columns: t.columns.filter(function(c){ return c.name; })
        };
      })
      .filter(function(t){ return t.columns.length > 0; });
  }

  function parseAnswer(text){
    var m = text.match(/```sql\s*([\s\S]*?)```/i);
    if(m){
      return { sql: m[1].trim(), explanation: text.slice(m.index+m[0].length).trim() };
    }
    var m2 = text.match(/```\s*([\s\S]*?)```/);
    if(m2){
      return { sql: m2[1].trim(), explanation: text.slice(m2.index+m2[0].length).trim() };
    }
    return { sql: text.trim(), explanation: "" };
  }

  function errorCopy(code){
    switch(code){
      case "not_configured": return "Сервер не настроен: в Vercel не задан OPENAI_API_KEY.";
      case "rate_limited": return "Лимит запросов к модели исчерпан — попробуйте позже.";
      case "prompt_too_large": return "Схема или вопрос слишком длинные — сократите описание.";
      case "empty_completion": return "Модель не вернула текст — сформулируйте вопрос иначе.";
      case "cancelled": return "Остановлено.";
      default: return "Не удалось сгенерировать запрос. Попробуйте ещё раз.";
    }
  }

  function requestSql(question, tables, signal){
    return fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, tables: tables }),
      signal: signal
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(data){
        if(!r.ok){
          var err = new Error(data.message || ("HTTP " + r.status));
          err.code = data.error || ("http_" + r.status);
          throw err;
        }
        return data;
      });
    });
  }

  function runGenerate(){
    var question = els.question.value.trim();
    if(!question) return;
    var tables = buildTablesPayload();
    if(tables.length === 0){
      setStatus("Сначала опишите хотя бы одну таблицу со столбцами слева и выберите её над вопросом.", "err");
      return;
    }

    els.genBtn.disabled = true;
    els.stopBtn.hidden = false;
    els.copyBtn.hidden = true;
    els.explain.textContent = "";
    els.codeWrap.innerHTML = '<div class="empty-out">Думаю над запросом…</div>';
    setStatus("Обращаюсь к модели…", "loading");

    var ctl = new AbortController();
    state.abortCtl = ctl;

    requestSql(question, tables, ctl.signal).then(function(res){
      var parsed = parseAnswer(res.text);
      showResult(parsed.sql, parsed.explanation);
      if(res.truncated){
        setStatus("Ответ обрезан — уточните вопрос.", "err");
      } else if(res.validated === true){
        setStatus("Готово. Запрос проверен на вашей схеме: таблицы, столбцы и синтаксис корректны" + (res.repairs ? " (исправлен автоматически)." : "."));
      } else if(res.validated === false){
        setStatus("Запрос не прошёл проверку на вашей схеме: " + String(res.validationError).replace(/[.\s]+$/, "") + ". Уточните вопрос или проверьте запрос вручную.", "err");
      } else {
        setStatus("Готово. Автоматическая проверка недоступна — проверьте запрос вручную.");
      }
      addHistory({
        question: question,
        sql: parsed.sql,
        explanation: parsed.explanation,
        createdAt: new Date().toISOString()
      });
    }).catch(function(e){
      var code = e && e.name === "AbortError" ? "cancelled" : (e && e.code);
      setStatus(errorCopy(code), code === "cancelled" ? undefined : "err");
      showEmptyResult();
    }).finally(function(){
      els.genBtn.disabled = false;
      els.stopBtn.hidden = true;
      state.abortCtl = null;
    });
  }

  els.addTableBtn.addEventListener("click", addTable);
  els.genBtn.addEventListener("click", runGenerate);
  els.question.addEventListener("keydown", function(e){
    if(e.key === "Enter" && (e.metaKey || e.ctrlKey)){ runGenerate(); }
  });
  els.stopBtn.addEventListener("click", function(){
    if(state.abortCtl) state.abortCtl.abort();
  });
  function copyText(text){
    var viaApi = navigator.clipboard && window.isSecureContext
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error("clipboard api unavailable"));
    return viaApi.catch(function(){ return legacyCopy(text); });
  }

  function legacyCopy(text){
    return new Promise(function(resolve, reject){
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try{ ok = document.execCommand("copy"); }catch(e){}
      document.body.removeChild(ta);
      if(ok) resolve(); else reject(new Error("copy failed"));
    });
  }

  var copyTimer = null;
  function flashCopyButton(label, cls){
    clearTimeout(copyTimer);
    els.copyBtn.textContent = label;
    els.copyBtn.classList.remove("done", "fail");
    els.copyBtn.classList.add(cls);
    copyTimer = setTimeout(function(){
      els.copyBtn.textContent = "Скопировать";
      els.copyBtn.classList.remove("done", "fail");
    }, 2000);
  }

  els.copyBtn.addEventListener("click", function(){
    var codeEl = els.codeWrap.querySelector("pre.sql");
    if(!codeEl) return;
    copyText(codeEl.textContent).then(function(){
      flashCopyButton("✓ Скопировано", "done");
    }).catch(function(){
      flashCopyButton("Не удалось скопировать", "fail");
    });
  });
  els.bannerClose.addEventListener("click", function(){
    els.banner.hidden = true;
    store(KEYS.banner, "1");
  });

  function init(){
    var seeded = false;
    try{
      var rawSchema = load(KEYS.schema);
      if(rawSchema) state.schema = JSON.parse(rawSchema);
    }catch(e){}
    if(!state.schema || !Array.isArray(state.schema.tables) || state.schema.tables.length === 0){
      state.schema = JSON.parse(JSON.stringify(EXAMPLE_SCHEMA));
      seeded = true;
    }
    state.selectedTables = state.schema.tables.map(function(_, i){ return i; });

    try{
      var rawHistory = load(KEYS.history);
      state.history = rawHistory ? JSON.parse(rawHistory) : [];
    }catch(e){ state.history = []; }

    renderSchema();
    renderHistory();
    if(seeded && !load(KEYS.banner)) els.banner.hidden = false;
    if(seeded){
      els.question.value = DEMO_QUESTION;
      showResult(DEMO_SQL, DEMO_EXPLANATION);
      setStatus("Пример готового результата. Нажмите «Сгенерировать SQL», чтобы получить запрос от модели.");
    }
  }

  init();
})();
