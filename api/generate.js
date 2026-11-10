const MAX_QUESTION_CHARS = 2000;
const MAX_SCHEMA_CHARS = 30000;
const MAX_TABLES = 50;
const MAX_COLUMNS = 300;
const MAX_REPAIRS = 4;
// Repairs stop after this long so the function never hits Vercel's hard timeout and loses the answer.
const REPAIR_DEADLINE_MS = 45000;

const SYSTEM_PROMPT = [
  "Ты — эксперт по PostgreSQL. Ты превращаешь вопросы на естественном языке в SQL-запросы",
  "строго по заданной схеме таблиц и не отвечаешь ни на что, кроме этой задачи.",
  "",
  "Правила, без которых запрос не выполнится или даст неверные числа:",
  "1. Используй только перечисленные таблицы и столбцы, имена пиши ровно как в схеме.",
  "   Имена с заглавными буквами, пробелами или кириллицей обязательно заключай в двойные кавычки.",
  "   Всегда задавай таблицам алиасы и указывай столбцы вместе с алиасом (c.city, o.created_at):",
  "   столбцы вроде id и created_at есть сразу в нескольких таблицах, без алиаса запрос не выполнится.",
  "   Псевдонимы столбцов из SELECT нельзя использовать в WHERE и HAVING — повтори выражение или вынеси его в CTE.",
  "   Это PostgreSQL: нет TOP, ISNULL, GETDATE, DATEADD, IFNULL — используй LIMIT, COALESCE, CURRENT_DATE, INTERVAL.",
  "2. В запросе с агрегатами каждый столбец в SELECT должен быть либо в GROUP BY, либо внутри агрегатной функции.",
  "   Не ссылайся в подзапросах внутри SELECT на несгруппированные столбцы внешнего запроса.",
  "   Оконные функции выполняются после GROUP BY: в OVER (PARTITION BY ... ORDER BY ...) допустимы только",
  "   сгруппированные столбцы и агрегаты.",
  "3. Не суммируй после JOIN по таблице с несколькими строками на одну запись: суммы задвоятся.",
  "   Сначала считай агрегаты в отдельных CTE (WITH ...) на нужной детализации, потом соединяй.",
  "4. Для «самый ... / топ-N в каждой группе» используй DISTINCT ON или ROW_NUMBER() OVER (PARTITION BY ...),",
  "   а не коррелированные подзапросы.",
  "5. Границы периодов задавай через CURRENT_DATE и date_trunc. «Последние N месяцев» — календарные месяцы.",
  "6. Если условие по сумме неоднозначно (за каждую группу или за весь период), считай его по итогу за весь период.",
  "7. Не добавляй фильтров, которых нет в вопросе, кроме очевидно необходимых; все такие решения перечисли в допущениях.",
  "8. Пиши один запрос. Не используй INSERT, UPDATE, DELETE и DDL, если вопрос этого не требует.",
  "",
  "Пример правильного решения задачи «по каждому региону выручка и самый продаваемый товар».",
  "Таблицы: sales(shop_id, product, qty, amount), shops(id, region).",
  "```sql",
  "WITH region_revenue AS (",
  "    SELECT sh.region, SUM(s.amount) AS revenue",
  "    FROM sales s",
  "    JOIN shops sh ON sh.id = s.shop_id",
  "    GROUP BY sh.region",
  "),",
  "top_product AS (",
  "    SELECT DISTINCT ON (sh.region) sh.region, s.product",
  "    FROM sales s",
  "    JOIN shops sh ON sh.id = s.shop_id",
  "    GROUP BY sh.region, s.product",
  "    ORDER BY sh.region, SUM(s.qty) DESC",
  ")",
  "SELECT r.region, r.revenue, t.product AS top_product",
  "FROM region_revenue r",
  "LEFT JOIN top_product t ON t.region = r.region",
  "ORDER BY r.region;",
  "```"
].join("\n");

const TYPE_RE = /^(smallint|int2|integer|int|int4|bigint|int8|serial|bigserial|numeric|decimal|real|float4|float8|float|double precision|boolean|bool|text|varchar|character varying|char|character|date|time|timestamp|timestamptz|timestamp with time zone|timestamp without time zone|uuid|json|jsonb|bytea|interval)(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/i;
const EXPLAINABLE_RE = /^(select|with|insert|update|delete|values|table)\b/i;

function cleanTables(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TABLES) return null;
  const tables = [];
  for (const t of input) {
    if (!t || typeof t.name !== "string" || !t.name.trim() || !Array.isArray(t.columns)) return null;
    const columns = t.columns
      .slice(0, MAX_COLUMNS)
      .filter((c) => c && typeof c.name === "string" && c.name.trim())
      .map((c) => ({
        name: c.name.trim(),
        type: typeof c.type === "string" ? c.type.trim() : "",
        description: typeof c.description === "string" ? c.description.trim() : ""
      }));
    if (columns.length === 0) continue;
    tables.push({
      name: t.name.trim(),
      description: typeof t.description === "string" ? t.description.trim() : "",
      columns
    });
  }
  return tables.length ? tables : null;
}

function schemaToText(tables) {
  return tables
    .map((t) => {
      const cols = t.columns
        .map((c) => "  - " + c.name + (c.type ? " (" + c.type + ")" : "") + ": " + (c.description || "без описания"))
        .join("\n");
      return 'Таблица "' + t.name + '"' + (t.description ? " — " + t.description : "") + "\nСтолбцы:\n" + cols;
    })
    .join("\n\n");
}

// Names are created exactly as the user typed them: all-lowercase names behave as unquoted ones,
// names with capitals, spaces or Cyrillic must be double-quoted in queries, as in a real PostgreSQL.
function ident(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

function pgType(type) {
  const t = type.replace(/\s+/g, " ");
  return TYPE_RE.test(t) ? t : "text";
}

function schemaToDdl(tables) {
  const seenTables = new Set();
  const statements = [];
  for (const t of tables) {
    const tableId = ident(t.name);
    if (seenTables.has(tableId)) continue;
    seenTables.add(tableId);
    const seenCols = new Set();
    const cols = [];
    for (const c of t.columns) {
      const colId = ident(c.name);
      if (seenCols.has(colId)) continue;
      seenCols.add(colId);
      cols.push("  " + colId + " " + pgType(c.type));
    }
    statements.push("CREATE TABLE " + tableId + " (\n" + cols.join(",\n") + "\n);");
  }
  return statements.join("\n");
}

async function openSandbox(tables) {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.waitReady;
    await db.exec(schemaToDdl(tables));
    return db;
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }
}

function extractSql(text) {
  const fenced = text.match(/```sql\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

// null = the query plans fine, string = PostgreSQL's error, undefined = statement type we do not check.
async function checkSql(db, sql) {
  if (!EXPLAINABLE_RE.test(sql)) return undefined;
  try {
    await db.query("EXPLAIN " + sql.replace(/;+\s*$/, ""));
    return null;
  } catch (err) {
    return String((err && err.message) || err).slice(0, 400);
  }
}

function buildUserPrompt(schemaText, question) {
  return (
    "Схема таблиц:\n" + schemaText + "\n\n" +
    'Вопрос пользователя: "' + question + '"\n\n' +
    "Формат ответа:\n" +
    "1. Блок кода ```sql ... ``` с готовым запросом (только валидный SQL, без комментариев с пояснениями внутри блока).\n" +
    "2. После блока — 1-3 предложения на русском: что делает запрос и какие допущения ты сделал, " +
    "если пришлось угадывать имя столбца, таблицы, логику соединения или толкование условия."
  );
}

function repairHint(error) {
  if (/must appear in the GROUP BY|ungrouped column/i.test(error)) {
    return (
      "Каждый столбец вне агрегатных функций в SELECT, ORDER BY и HAVING должен входить в GROUP BY. " +
      "Оконные функции выполняются после GROUP BY: в PARTITION BY и ORDER BY внутри OVER можно использовать " +
      "только сгруппированные столбцы и агрегаты. Если нужны и итоги по группе, и значения из отдельных строк " +
      "(например, самый продаваемый товар), посчитай их в разных CTE и соедини по ключам группы."
    );
  }
  if (/ambiguous/i.test(error)) {
    return (
      "Столбец с таким именем есть в нескольких таблицах запроса. Задай таблицам алиасы и укажи каждый столбец " +
      "вместе с алиасом (например, o.created_at) во всех частях запроса: SELECT, WHERE, GROUP BY, ORDER BY."
    );
  }
  if (/function .* does not exist|operator does not exist|cannot be matched|invalid input syntax/i.test(error)) {
    return (
      "Проверь типы и функции PostgreSQL: приводи значения через ::тип, даты сравнивай с датами. " +
      "Нет TOP, ISNULL, GETDATE, DATEADD, IFNULL — используй LIMIT, COALESCE, CURRENT_DATE, INTERVAL."
    );
  }
  if (/does not exist/i.test(error)) {
    return (
      "Используй только таблицы и столбцы из схемы; имена с заглавными буквами, пробелами и кириллицей — " +
      "в двойных кавычках. Проверь, какой таблице принадлежит столбец. Псевдонимы столбцов из SELECT нельзя " +
      "использовать в WHERE и HAVING — повтори выражение или вынеси его в CTE."
    );
  }
  if (/syntax error/i.test(error)) {
    return (
      "Проверь синтаксис PostgreSQL: запятые, скобки, ключевые слова. " +
      "Нет TOP, ISNULL, GETDATE, DATEADD, IFNULL — используй LIMIT, COALESCE, CURRENT_DATE, INTERVAL."
    );
  }
  return "";
}

const REWRITE_HINT =
  "Прошлые исправления не помогли, поэтому перепиши запрос с нуля по каркасу: " +
  "1) CTE base — только соединения и фильтры, без агрегатов; " +
  "2) отдельный CTE на каждый агрегат с явным GROUP BY всех неагрегированных столбцов; " +
  "3) для «самого ... в группе» — отдельный CTE с DISTINCT ON или ROW_NUMBER(); " +
  "4) итоговый SELECT только соединяет CTE по ключам группы.";

function buildRepairPrompt(error, attempt) {
  return (
    "Проверка запроса в PostgreSQL на этой схеме вернула ошибку:\n" + error + "\n\n" +
    [repairHint(error), attempt > 0 ? REWRITE_HINT : ""].filter(Boolean).join("\n") + "\n\n" +
    "Исправь запрос так, чтобы он выполнялся, не меняя смысла вопроса. " +
    "Ответ в том же формате: блок ```sql ... ``` и 1-3 предложения с пояснением и допущениями."
  );
}

async function chat(apiKey, messages) {
  // OPENAI_BASE_URL is set only when self-hosting where api.openai.com is blocked (relay URL ending in /v1).
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const upstream = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    // Low temperature for the default model; a custom OPENAI_MODEL may not accept the parameter.
    body: JSON.stringify(Object.assign(
      { model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages, max_completion_tokens: 3000 },
      process.env.OPENAI_MODEL ? {} : { temperature: 0.2 }
    ))
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("OpenAI error", upstream.status, detail.slice(0, 500));
    const err = new Error("upstream " + upstream.status);
    err.status = upstream.status;
    throw err;
  }
  const data = await upstream.json();
  const choice = data.choices && data.choices[0];
  const text = choice && choice.message && choice.message.content ? choice.message.content : "";
  return { text, truncated: Boolean(choice && choice.finish_reason === "length") };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "Используйте POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "not_configured",
      message: "На сервере не задана переменная OPENAI_API_KEY."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const question = body && typeof body.question === "string" ? body.question.trim() : "";
  const tables = body ? cleanTables(body.tables) : null;
  if (!question || !tables) {
    return res.status(400).json({ error: "invalid_request", message: "Нужны поля question и tables." });
  }
  const schemaText = schemaToText(tables);
  if (question.length > MAX_QUESTION_CHARS || schemaText.length > MAX_SCHEMA_CHARS) {
    return res.status(413).json({ error: "prompt_too_large", message: "Вопрос или схема слишком длинные." });
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(schemaText, question) }
  ];

  let current;
  try {
    current = await chat(apiKey, messages);
  } catch (err) {
    if (err.status === 429) {
      return res.status(429).json({ error: "rate_limited", message: "Лимит запросов к модели исчерпан." });
    }
    return res.status(502).json({ error: "upstream_error", message: "Не удалось получить ответ модели." });
  }
  if (!current.text.trim()) {
    return res.status(502).json({ error: "empty_completion", message: "Модель не вернула текст." });
  }

  // validated: true — запрос прошёл EXPLAIN на вашей схеме; false — не прошёл; null — проверить не удалось.
  let validated = null;
  let validationError = null;
  let repairs = 0;
  let db = null;
  const startedAt = Date.now();
  try {
    db = await openSandbox(tables);
  } catch (err) {
    console.error("sandbox unavailable", err && err.message);
  }

  if (db) {
    try {
      for (;;) {
        const verdict = await checkSql(db, extractSql(current.text));
        if (verdict === undefined) break;
        if (verdict === null) { validated = true; break; }
        validated = false;
        validationError = verdict;
        if (repairs >= MAX_REPAIRS || Date.now() - startedAt > REPAIR_DEADLINE_MS) break;
        messages.push({ role: "assistant", content: current.text });
        messages.push({ role: "user", content: buildRepairPrompt(verdict, repairs) });
        try {
          const fixed = await chat(apiKey, messages);
          if (!fixed.text.trim()) break;
          current = fixed;
          repairs += 1;
        } catch (err) {
          break;
        }
      }
    } finally {
      await db.close().catch(() => {});
    }
  }

  return res.status(200).json({
    text: current.text,
    truncated: current.truncated,
    validated,
    validationError: validated === false ? validationError : null,
    repairs
  });
};
