import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateTerminalPerfHtmlReport,
  parseHtmlReportArgs
} from './generate-terminal-perf-html-report.mjs'

const tempDirs = []

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-terminal-perf-html-'))
  tempDirs.push(dir)
  return dir
}

function writeReport(annotationDescription, annotationType = 'opencode-scale-same-workspace-25') {
  const dir = makeTempDir()
  const reportPath = join(dir, 'report.json')
  writeFileSync(
    reportPath,
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: annotationType,
                      description: annotationDescription
                    },
                    {
                      type: 'browser-unrelated',
                      description: 'median=999.0ms'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
  )
  return reportPath
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('generate-terminal-perf-html-report', () => {
  it('parses input paths and output flags', () => {
    expect(parseHtmlReportArgs(['--', 'a.json', 'b.json', '--output', 'out.html'])).toEqual({
      inputPaths: ['a.json', 'b.json'],
      outputPath: 'out.html'
    })
    expect(
      parseHtmlReportArgs(['a.json'], { ORCA_E2E_TERMINAL_PERF_HTML_REPORT_PATH: 'env.html' })
    ).toEqual({
      inputPaths: ['a.json'],
      outputPath: 'env.html'
    })
    expect(() => parseHtmlReportArgs(['--output'])).toThrow('--output requires a path')
    expect(() => parseHtmlReportArgs([])).toThrow('Usage:')
  })

  it('writes an HTML report with charts, table rows, and escaped input', () => {
    const reportPath = writeReport(
      [
        'panes=25',
        'frames=60',
        'median=12.4ms',
        'worst=44.8ms',
        'scroll=61.0ms',
        'restore=320.0ms',
        'maxTimerDrift=8.0ms',
        'rendererPeakQueuedChars=2048',
        'mainPeakInFlightChars=4096',
        'heldAckChars=1024',
        'hiddenSkippedChars=512',
        'rendererDroppedBacklogs=0'
      ].join(' ')
    )
    const outputPath = join(makeTempDir(), 'report.html')

    const result = generateTerminalPerfHtmlReport({
      inputPaths: [reportPath],
      outputPath,
      now: new Date('2026-06-09T10:00:00.000Z')
    })

    const html = readFileSync(outputPath, 'utf8')
    expect(result).toEqual({ failureCount: 0, outputPath, rowCount: 1 })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Terminal Performance Impact Report')
    expect(html).toContain('2026-06-09T10:00:00.000Z')
    expect(html).toContain('Same workspace panes: typing latency')
    expect(html).toContain('opencode-scale-same-workspace-25')
    expect(html).toContain('<table>')
    expect(html).toContain('Pass')
    expect(html).not.toContain('browser-unrelated')
  })

  it('marks over-budget rows as failures', () => {
    const reportPath = writeReport(
      [
        'panes=100',
        'median=80.0ms',
        'worst=301.0ms',
        'rendererPeakQueuedChars=2097153',
        'rendererDroppedBacklogs=1'
      ].join(' '),
      'opencode-scale-cross-workspace-100'
    )
    const outputPath = join(makeTempDir(), 'report.html')

    const result = generateTerminalPerfHtmlReport({ inputPaths: [reportPath], outputPath })

    const html = readFileSync(outputPath, 'utf8')
    expect(result.failureCount).toBe(4)
    expect(html).toContain('4 failures')
    expect(html).toContain('fail: Median typing 80.0ms &gt; 75.0ms')
    expect(html).toContain('Cross-workspace hidden panes')
  })

  it('fails when reports contain no terminal perf annotations', () => {
    const reportPath = writeReport('median=12.0ms', 'browser-unrelated')

    expect(() =>
      generateTerminalPerfHtmlReport({
        inputPaths: [reportPath],
        outputPath: join(makeTempDir(), 'report.html')
      })
    ).toThrow('No OpenCode terminal perf annotations found.')
  })
})
