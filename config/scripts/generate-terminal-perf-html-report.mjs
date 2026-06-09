import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUTPUT_PATH = 'test-results/terminal-perf-impact-report.html'

const BUDGETS = {
  medianMs: 75,
  worstMs: 300,
  maxTimerDriftMs: 150,
  scrollMs: 150,
  restoreMs: 1000,
  rendererQueuedChars: 2 * 1024 * 1024,
  rendererPeakQueuedChars: 2 * 1024 * 1024,
  rendererDroppedBacklogs: 0
}

const SCENARIO_LABELS = [
  ['opencode-scale-same-workspace', 'Same workspace panes'],
  ['opencode-scale-cross-workspace', 'Cross-workspace hidden panes'],
  ['opencode-scale-pressure', 'ACK-backpressured PTYs'],
  ['opencode-scale-hidden-pressure', 'Hidden real PTYs'],
  ['opencode-cross-workspace-typing', 'Cross-workspace typing'],
  ['opencode-main-pressure', 'Main renderer pressure'],
  ['opencode-hidden-pressure', 'Hidden pressure'],
  ['opencode-revisit-pressure', 'Revisit under pressure']
]

export function parseHtmlReportArgs(argv, env = process.env) {
  const args = [...argv]
  if (args[0] === '--') {
    args.shift()
  }

  const inputPaths = []
  let outputPath = env.ORCA_E2E_TERMINAL_PERF_HTML_REPORT_PATH || DEFAULT_OUTPUT_PATH
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--output' || arg === '-o') {
      const next = args[index + 1]
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a path`)
      }
      outputPath = next
      index += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length)
      continue
    }
    inputPaths.push(arg)
  }

  if (inputPaths.length === 0) {
    throw new Error(
      'Usage: node config/scripts/generate-terminal-perf-html-report.mjs <playwright-json>... --output <report.html>'
    )
  }
  return { inputPaths, outputPath }
}

function readJsonReport(path) {
  const raw = readFileSync(path, 'utf8')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`${path}: no JSON object found`)
  }
  return JSON.parse(raw.slice(start, end + 1))
}

function parseAnnotationDescription(description) {
  const values = {}
  for (const part of description.split(/\s+/)) {
    const index = part.indexOf('=')
    if (index === -1) {
      continue
    }
    values[part.slice(0, index)] = part.slice(index + 1)
  }
  return values
}

function collectTerminalPerfRows(report, source) {
  const rows = []
  const visitSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const annotation of test.annotations ?? []) {
          if (!annotation.type.startsWith('opencode-')) {
            continue
          }
          rows.push(
            normalizeRow({
              source,
              scenario: annotation.type,
              ...parseAnnotationDescription(annotation.description ?? '')
            })
          )
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visitSuite(child)
    }
  }
  for (const suite of report.suites ?? []) {
    visitSuite(suite)
  }
  return rows
}

function parseMs(value) {
  const match = String(value ?? '').match(/^(-?\d+(?:\.\d+)?)ms$/)
  return match ? Number(match[1]) : null
}

function parseCount(value) {
  if (value == null || value === '') {
    return null
  }
  const count = Number(value)
  return Number.isFinite(count) ? count : null
}

function normalizeRow(row) {
  const panes = parseCount(row.panes)
  const frames = parseCount(row.frames)
  const medianMs = parseMs(row.median)
  const worstMs = parseMs(row.worst)
  const maxTimerDriftMs = parseMs(row.maxTimerDrift)
  const scrollMs = parseMs(row.scroll)
  const restoreMs = parseMs(row.restore)
  const rendererQueuedChars = parseCount(row.rendererQueuedChars)
  const rendererPeakQueuedChars = parseCount(row.rendererPeakQueuedChars)
  const rendererDroppedBacklogs = parseCount(row.rendererDroppedBacklogs)
  return {
    ...row,
    group: scenarioGroup(row.scenario),
    panes,
    frames,
    medianMs,
    worstMs,
    maxTimerDriftMs,
    scrollMs,
    restoreMs,
    rendererQueuedChars,
    rendererPeakQueuedChars,
    rendererDroppedBacklogs,
    mainPeakPendingChars: parseCount(row.mainPeakPendingChars),
    mainPeakInFlightChars: parseCount(row.mainPeakInFlightChars),
    heldAckChars: parseCount(row.heldAckChars),
    hiddenSkippedChars: parseCount(row.hiddenSkippedChars)
  }
}

function scenarioGroup(scenario) {
  for (const [prefix, label] of SCENARIO_LABELS) {
    if (scenario.startsWith(prefix)) {
      return label
    }
  }
  return 'Other terminal scenarios'
}

function budgetFailures(row) {
  const failures = []
  for (const [key, budget] of Object.entries(BUDGETS)) {
    const value = row[key]
    if (value == null) {
      continue
    }
    if (value > budget) {
      failures.push(
        `${labelForMetric(key)} ${formatMetricValue(key, value)} > ${formatMetricValue(key, budget)}`
      )
    }
  }
  return failures
}

function labelForMetric(key) {
  return (
    {
      medianMs: 'Median typing',
      worstMs: 'Worst typing',
      maxTimerDriftMs: 'Timer drift',
      scrollMs: 'Scroll',
      restoreMs: 'Restore',
      rendererQueuedChars: 'Renderer queued',
      rendererPeakQueuedChars: 'Renderer peak queued',
      rendererDroppedBacklogs: 'Renderer dropped backlogs'
    }[key] ?? key
  )
}

function formatMetricValue(key, value) {
  if (value == null) {
    return ''
  }
  if (key.endsWith('Ms')) {
    return `${value.toFixed(1)}ms`
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatCell(value, suffix = '') {
  if (value == null || value === '') {
    return ''
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}${suffix}` : `${value.toFixed(1)}${suffix}`
  }
  return String(value)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function groupRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    const existing = groups.get(row.group) ?? []
    existing.push(row)
    groups.set(row.group, existing)
  }
  return [...groups.entries()].map(([label, group]) => [
    label,
    group.sort((a, b) => (a.panes ?? 0) - (b.panes ?? 0) || a.scenario.localeCompare(b.scenario))
  ])
}

function chartSvg(title, rows, metrics) {
  const plotRows = rows.filter(
    (row) => row.panes != null && metrics.some((metric) => row[metric.key] != null)
  )
  if (plotRows.length === 0) {
    return ''
  }
  const width = 720
  const height = 260
  const pad = { bottom: 42, left: 54, right: 20, top: 28 }
  const minPane = Math.min(...plotRows.map((row) => row.panes))
  const maxPane = Math.max(...plotRows.map((row) => row.panes))
  const maxValue = Math.max(
    1,
    ...plotRows.flatMap((row) => metrics.map((metric) => row[metric.key] ?? 0))
  )
  const x = (pane) => {
    if (minPane === maxPane) {
      return pad.left + (width - pad.left - pad.right) / 2
    }
    return pad.left + ((pane - minPane) / (maxPane - minPane)) * (width - pad.left - pad.right)
  }
  const y = (value) => height - pad.bottom - (value / maxValue) * (height - pad.top - pad.bottom)
  const axis = [
    `<line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />`,
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />`
  ].join('')
  const series = metrics
    .map((metric) => {
      const points = plotRows
        .filter((row) => row[metric.key] != null)
        .map((row) => `${x(row.panes).toFixed(1)},${y(row[metric.key]).toFixed(1)}`)
        .join(' ')
      if (!points) {
        return ''
      }
      return `<polyline class="series ${metric.className}" points="${points}" /><g>${plotRows
        .filter((row) => row[metric.key] != null)
        .map(
          (row) =>
            `<circle class="point ${metric.className}" cx="${x(row.panes).toFixed(1)}" cy="${y(row[metric.key]).toFixed(1)}" r="3"><title>${escapeHtml(row.scenario)} ${metric.label}: ${escapeHtml(formatCell(row[metric.key], metric.suffix ?? ''))}</title></circle>`
        )
        .join('')}</g>`
    })
    .join('')
  const xLabels = [...new Set(plotRows.map((row) => row.panes))]
    .sort((a, b) => a - b)
    .map(
      (pane) =>
        `<text class="axis-label" x="${x(pane).toFixed(1)}" y="${height - 12}" text-anchor="middle">${pane}</text>`
    )
    .join('')
  const yLabels = [0, maxValue / 2, maxValue]
    .map(
      (value) =>
        `<text class="axis-label" x="${pad.left - 8}" y="${y(value).toFixed(1)}" text-anchor="end">${formatLargeValue(value)}</text>`
    )
    .join('')
  const legend = metrics
    .map((metric) => `<span><i class="${metric.className}"></i>${escapeHtml(metric.label)}</span>`)
    .join('')
  return `<section class="chart"><div class="chart-title">${escapeHtml(title)}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${axis}${series}${xLabels}${yLabels}<text class="axis-title" x="${width / 2}" y="${height - 2}" text-anchor="middle">Pane count</text></svg><div class="legend">${legend}</div></section>`
}

function formatLargeValue(value) {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}M`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(0)}k`
  }
  return value.toFixed(value % 1 === 0 ? 0 : 1)
}

function renderTable(rows) {
  const columns = [
    ['Scenario', (row) => row.scenario],
    ['Source', (row) => row.source],
    ['Panes', (row) => row.panes],
    ['Frames', (row) => row.frames],
    ['Median', (row) => formatCell(row.medianMs, 'ms')],
    ['Worst', (row) => formatCell(row.worstMs, 'ms')],
    ['Scroll', (row) => formatCell(row.scrollMs, 'ms')],
    ['Restore', (row) => formatCell(row.restoreMs, 'ms')],
    ['Drift', (row) => formatCell(row.maxTimerDriftMs, 'ms')],
    ['Renderer Peak', (row) => row.rendererPeakQueuedChars],
    ['Main In-Flight', (row) => row.mainPeakInFlightChars],
    ['Held ACK', (row) => row.heldAckChars],
    ['Hidden Chars', (row) => row.hiddenSkippedChars],
    ['Drops', (row) => row.rendererDroppedBacklogs],
    [
      'Budget',
      (row) => {
        const failures = budgetFailures(row)
        return failures.length === 0 ? 'pass' : `fail: ${failures.join('; ')}`
      }
    ]
  ]
  return `<table><thead><tr>${columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => {
      const failed = budgetFailures(row).length > 0
      return `<tr class="${failed ? 'failed' : ''}">${columns
        .map(([, getter]) => `<td>${escapeHtml(getter(row))}</td>`)
        .join('')}</tr>`
    })
    .join('')}</tbody></table>`
}

function renderHtml({ generatedAt, inputPaths, rows }) {
  const failures = rows.flatMap((row) => budgetFailures(row).map((failure) => ({ failure, row })))
  const grouped = groupRows(rows)
  const chartSections = grouped
    .map(([label, group]) =>
      [
        chartSvg(`${label}: typing latency`, group, [
          { className: 'metric-a', key: 'medianMs', label: 'Median', suffix: 'ms' },
          { className: 'metric-b', key: 'worstMs', label: 'Worst', suffix: 'ms' }
        ]),
        chartSvg(`${label}: renderer/main pressure`, group, [
          { className: 'metric-c', key: 'rendererPeakQueuedChars', label: 'Renderer peak chars' },
          { className: 'metric-d', key: 'mainPeakInFlightChars', label: 'Main in-flight chars' },
          { className: 'metric-e', key: 'mainPeakPendingChars', label: 'Main pending chars' }
        ]),
        chartSvg(`${label}: restore and scroll`, group, [
          { className: 'metric-f', key: 'restoreMs', label: 'Restore', suffix: 'ms' },
          { className: 'metric-g', key: 'scrollMs', label: 'Scroll', suffix: 'ms' }
        ])
      ].join('')
    )
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terminal Performance Impact Report</title>
  <style>
    :root { color-scheme: light dark; --bg: #f8fafc; --fg: #111827; --muted: #64748b; --line: #cbd5e1; --card: #ffffff; --bad: #b91c1c; --ok: #047857; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --fg: #e5e7eb; --muted: #94a3b8; --line: #334155; --card: #111827; --bad: #f87171; --ok: #34d399; } }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 20px; margin: 32px 0 12px; }
    .meta, .summary { color: var(--muted); }
    .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin: 18px 0 24px; }
    .card, .chart { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .card strong { display: block; font-size: 24px; }
    .ok { color: var(--ok); }
    .bad { color: var(--bad); }
    table { border-collapse: collapse; width: 100%; background: var(--card); border: 1px solid var(--line); }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    tr.failed td:last-child { color: var(--bad); font-weight: 600; }
    .chart { margin: 14px 0; }
    .chart-title { font-weight: 700; margin-bottom: 8px; }
    svg { width: 100%; height: auto; overflow: visible; }
    svg line { stroke: var(--line); }
    .axis-label, .axis-title { fill: var(--muted); font-size: 11px; }
    .series { fill: none; stroke-width: 2.5; }
    .point { stroke: var(--card); stroke-width: 1; }
    .metric-a { stroke: #2563eb; fill: #2563eb; } .metric-b { stroke: #dc2626; fill: #dc2626; }
    .metric-c { stroke: #7c3aed; fill: #7c3aed; } .metric-d { stroke: #059669; fill: #059669; } .metric-e { stroke: #f59e0b; fill: #f59e0b; }
    .metric-f { stroke: #0891b2; fill: #0891b2; } .metric-g { stroke: #db2777; fill: #db2777; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 12px; }
    .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
    .sources { word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>Terminal Performance Impact Report</h1>
    <p class="meta">Generated ${escapeHtml(generatedAt)} from ${inputPaths.length} Playwright JSON report${inputPaths.length === 1 ? '' : 's'}.</p>
    <p class="sources">${inputPaths.map((path) => escapeHtml(path)).join('<br>')}</p>
    <div class="cards">
      <div class="card"><span>Scenario rows</span><strong>${rows.length}</strong></div>
      <div class="card"><span>Budget status</span><strong class="${failures.length === 0 ? 'ok' : 'bad'}">${failures.length === 0 ? 'Pass' : `${failures.length} failure${failures.length === 1 ? '' : 's'}`}</strong></div>
      <div class="card"><span>Max panes</span><strong>${Math.max(...rows.map((row) => row.panes ?? 0))}</strong></div>
      <div class="card"><span>Max renderer peak chars</span><strong>${formatLargeValue(Math.max(...rows.map((row) => row.rendererPeakQueuedChars ?? 0)))}</strong></div>
    </div>
    <h2>Impact Charts</h2>
    ${chartSections || '<p class="summary">No chartable pane-count rows were found.</p>'}
    <h2>Scenario Metrics</h2>
    ${renderTable(rows)}
    <h2>Correctness Gates To Pair With This Report</h2>
    <p class="summary">Pair this performance report with hidden TUI visual restore, terminal rendering golden, long-table restore, sleep/wake restore, SSH/remote ACK pressure, and WebSocket multiplex pressure evidence before declaring the terminal performance goal complete.</p>
  </main>
</body>
</html>
`
}

export function generateTerminalPerfHtmlReport({ inputPaths, outputPath, now = new Date() }) {
  const rows = inputPaths.flatMap((path) =>
    collectTerminalPerfRows(readJsonReport(path), basename(path))
  )
  if (rows.length === 0) {
    throw new Error('No OpenCode terminal perf annotations found.')
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  const html = renderHtml({ generatedAt: now.toISOString(), inputPaths, rows })
  writeFileSync(outputPath, html)
  return { outputPath, rowCount: rows.length, failureCount: rows.flatMap(budgetFailures).length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = generateTerminalPerfHtmlReport(parseHtmlReportArgs(process.argv.slice(2)))
    console.log(
      `Terminal perf HTML report saved to ${result.outputPath} (${result.rowCount} row${result.rowCount === 1 ? '' : 's'}, ${result.failureCount} budget failure${result.failureCount === 1 ? '' : 's'}).`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
