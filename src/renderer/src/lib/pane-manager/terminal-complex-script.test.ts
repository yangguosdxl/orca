import { describe, expect, it } from 'vitest'
import {
  nativeWindowsRewriteNeedsFollowupRenderRefresh,
  terminalOutputContainsEastAsianRendererRisk,
  terminalOutputPrefersRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh,
  windowsEastAsianOutputPrefersRenderRefresh,
  type TerminalRewriteOutputRenderRefreshState
} from './terminal-complex-script'

describe('terminalOutputPrefersRenderRefresh', () => {
  it('detects Arabic terminal output', () => {
    expect(terminalOutputPrefersRenderRefresh('Arabic: السلام عليكم')).toBe(true)
  })

  it('detects RTL scripts that need browser text shaping/order', () => {
    expect(terminalOutputPrefersRenderRefresh('Hebrew: שלום')).toBe(true)
  })

  it('detects East Asian wide and fullwidth terminal output', () => {
    expect(
      terminalOutputPrefersRenderRefresh('直接接请求本地 /api/mcp，带同一个 Bearer token，成功')
    ).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Japanese: ターミナル')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Korean: 터미널')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Fullwidth: ＡＢＣ１２３')).toBe(true)
  })

  it('keeps terminal drawing glyphs on WebGL', () => {
    expect(terminalOutputPrefersRenderRefresh('⠋ Working')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('├─ file.ts')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('█ progress')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('◆ status')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\uE0B0 prompt')).toBe(false)
  })

  it('detects malformed replacement characters', () => {
    expect(terminalOutputPrefersRenderRefresh('bad replacement �')).toBe(true)
  })

  it('detects emoji and variation sequences', () => {
    expect(terminalOutputPrefersRenderRefresh('status 🚀')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('developer 👩‍💻')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('heart ♥️')).toBe(true)
  })

  it('detects supplementary-plane complex-script ranges', () => {
    expect(terminalOutputPrefersRenderRefresh('Adlam: 𞤀')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Medefaidrin: 𐻀')).toBe(true)
  })

  it('detects split surrogate chunks so refresh is not lost at chunk boundaries', () => {
    const [high, low] = Array.from('🚀')[0].split('')

    expect(terminalOutputPrefersRenderRefresh(high)).toBe(true)
    expect(terminalOutputPrefersRenderRefresh(low)).toBe(true)
  })

  it('detects ASCII ANSI background SGR output before the non-ASCII fast path', () => {
    expect(terminalOutputPrefersRenderRefresh('\x1b[48;2;12;34;56m codex input \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[48:2::12:34:56m codex input \x1b[0m')).toBe(
      true
    )
    expect(terminalOutputPrefersRenderRefresh('\x1b[44m selected block \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[104m bright selected block \x1b[0m')).toBe(true)
  })

  it('does not disable WebGL for ordinary terminal output or ANSI controls alone', () => {
    expect(terminalOutputPrefersRenderRefresh('abc 123 ✓')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\x1b[32mplain green\x1b[0m')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\x1b[38;2;48;34;56m foreground only\x1b[0m')).toBe(
      false
    )
    expect(terminalOutputPrefersRenderRefresh('\x1b[38:2::48:34:56m foreground only\x1b[0m')).toBe(
      false
    )
  })
})

describe('terminalOutputContainsEastAsianRendererRisk', () => {
  it('detects CJK, fullwidth, and Korean output', () => {
    expect(terminalOutputContainsEastAsianRendererRisk('已经安装完成，软件已更新后重启。')).toBe(
      true
    )
    expect(terminalOutputContainsEastAsianRendererRisk('Fullwidth: ＡＢＣ１２３')).toBe(true)
    expect(terminalOutputContainsEastAsianRendererRisk('Korean: 터미널')).toBe(true)
  })

  it('does not match non-East-Asian renderer-risk Unicode', () => {
    expect(terminalOutputContainsEastAsianRendererRisk('Arabic: السلام عليكم')).toBe(false)
    expect(terminalOutputContainsEastAsianRendererRisk('status 🚀')).toBe(false)
    expect(terminalOutputContainsEastAsianRendererRisk('developer 👩‍💻')).toBe(false)
  })
})

describe('windowsEastAsianOutputPrefersRenderRefresh', () => {
  const maxInteractiveRedrawChars = 128 * 1024

  it('refreshes native Windows ConPTY agent output with CJK or Korean glyphs', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(true)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('Korean: 터미널', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(true)
  })

  it('keeps the recent-input Windows renderer path for SSH and other non-native panes', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: true,
        isNativeWindowsConpty: false,
        hadRecentInput: true,
        maxInteractiveRedrawChars
      })
    ).toBe(true)
  })

  it('skips remote agent output and non-Windows clients without recent input', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: true,
        isNativeWindowsConpty: false,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: false,
        isNativeWindowsConpty: false,
        hadRecentInput: true,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
  })

  it('does not refresh ASCII, non-East-Asian Unicode, or bulk chunks', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('plain terminal output', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('Arabic: السلام عليكم', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已'.repeat(maxInteractiveRedrawChars + 1), {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
  })
})

describe('terminalRewriteOutputPrefersRenderRefresh', () => {
  it('detects in-place carriage-return redraws', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\r• Working')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('prefix\r\x1b[2K• Working')).toBe(true)
  })

  it('does not treat normal CRLF output as an in-place redraw', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('line one\r\nline two\r\n')).toBe(false)
  })

  it('waits on a trailing carriage return so split CRLF output does not refresh early', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('line one\r')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\nline two')).toBe(false)
  })

  it('detects terminal erase rewrites and backspace updates', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2K• Working')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2J\x1b[Hredraw')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('progress 10%\b\b20%')).toBe(true)
  })

  it('still detects split Codex-style rewrites through the erase-line chunk', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\r')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2K• Working')).toBe(true)
  })

  it('ignores ordinary cursor movement and style output', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[10;2Hcursor move')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[32mplain green\x1b[0m')).toBe(false)
  })
})

describe('terminalRewriteOutputRenderRefreshDecision', () => {
  it('refreshes when a trailing carriage return continues as a split redraw', () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision('\r', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('• Working without erase-line', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('does not refresh split CRLF output', () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision('line one\r', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('\nline two', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })
  })

  it('refreshes when a rewrite erase sequence is split across chunks', () => {
    const trailingRewriteCsi = terminalRewriteOutputRenderRefreshDecision('\r\x1b[', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingRewriteCsi).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '\x1b[',
      prefersRenderRefresh: true
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('2K• Working', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('carries rewrite erase sequence tails split before CSI introducer or params', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision('\x1b', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '\x1b',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('2J', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('drops overlong rewrite CSI tails', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision(`\x1b[${'1'.repeat(80)}`, {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })
  })

  it('preserves pending trailing carriage return state across empty chunks', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision('', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '\x1b[',
      prefersRenderRefresh: false
    })
  })
})

describe('nativeWindowsRewriteNeedsFollowupRenderRefresh', () => {
  // 原因：Claude Code 会用 CR + CHA + 重印 + erase-line 原地回显输入行；
  // 在 native Windows 上需要下一帧补刷，避免用户只能靠调整窗口修复残影。
  function rewriteIsInPlace(chunks: string[]): boolean[] {
    const state: TerminalRewriteOutputRenderRefreshState = {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    }
    return chunks.map((chunk) => {
      const decision = terminalRewriteOutputRenderRefreshDecision(chunk, state)
      state.previousChunkEndsWithCarriageReturn = decision.nextChunkEndsWithCarriageReturn
      state.previousRewriteCsiScanTail = decision.nextRewriteCsiScanTail
      return decision.prefersRenderRefresh
    })
  }

  it('schedules a follow-up repaint for the split Claude prompt redraw on native Windows', () => {
    // "> " 提示符后用户输入 z、z、z、x；每次按键都会原地重绘。
    const claudeRedrawChunks = [
      '\r\x1b[3G',
      'z\x1b[K',
      '\r\x1b[3G',
      'zz\x1b[K',
      '\r\x1b[3G',
      'zzz\x1b[K',
      '\r\x1b[3G',
      'zzzx\x1b[K'
    ]
    const inPlace = rewriteIsInPlace(claudeRedrawChunks)
    // 每个重绘块都是原地改写：要么延续 CR，要么包含 erase-line。
    expect(inPlace.every(Boolean)).toBe(true)
    for (const isInPlaceRewrite of inPlace) {
      expect(
        nativeWindowsRewriteNeedsFollowupRenderRefresh({
          isNativeWindowsConpty: true,
          isForeground: true,
          isInPlaceRewrite
        })
      ).toBe(true)
    }
  })

  it('does not schedule a follow-up repaint for ordinary CRLF foreground output', () => {
    const inPlace = rewriteIsInPlace(['line one\r\n', 'line two\r\n'])
    expect(inPlace).toEqual([false, false])
    for (const isInPlaceRewrite of inPlace) {
      expect(
        nativeWindowsRewriteNeedsFollowupRenderRefresh({
          isNativeWindowsConpty: true,
          isForeground: true,
          isInPlaceRewrite
        })
      ).toBe(false)
    }
  })

  it('stays off for non-Windows renderers and background writes', () => {
    expect(
      nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: false,
        isForeground: true,
        isInPlaceRewrite: true
      })
    ).toBe(false)
    expect(
      nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: true,
        isForeground: false,
        isInPlaceRewrite: true
      })
    ).toBe(false)
  })
})

describe('windowsEastAsianOutputPrefersRenderRefresh', () => {
  const NATIVE_CONPTY = {
    isWindowsClient: true,
    isNativeWindowsConpty: true,
    hadRecentInput: false,
    maxInteractiveRedrawChars: 128 * 1024
  }

  // 原因：回归覆盖 #5921；Codex/Antigravity 原地重绘 CJK 块时，本地 Windows
  // DOM 渲染器可能叠印上一帧宽字形，所以无最近输入的 Agent 输出也要刷新。
  it('refreshes native-ConPTY agent CJK output without recent input', () => {
    expect(windowsEastAsianOutputPrefersRenderRefresh('如果还在主 checkout', NATIVE_CONPTY)).toBe(
      true
    )
  })

  it('refreshes native-ConPTY Korean output without recent input', () => {
    expect(windowsEastAsianOutputPrefersRenderRefresh('한국어 출력', NATIVE_CONPTY)).toBe(true)
  })

  it('refreshes CJK output split from its cursor-position CSI in a prior chunk', () => {
    // 原因：主进程批处理窗口可能把 CUP 光标移动和字形载荷切到不同块；
    // 只有 CJK 的块没有控制字节，也仍然需要重绘。
    expect(windowsEastAsianOutputPrefersRenderRefresh('设计专用 worktree', NATIVE_CONPTY)).toBe(
      true
    )
  })

  it('still refreshes recent-input CJK on a non-ConPTY Windows client (Pinyin commit)', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('请创建', {
        isWindowsClient: true,
        isNativeWindowsConpty: false,
        hadRecentInput: true,
        maxInteractiveRedrawChars: 128 * 1024
      })
    ).toBe(true)
  })

  it('does not refresh East Asian output on non-Windows panes', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('如果还在主', {
        isWindowsClient: false,
        isNativeWindowsConpty: false,
        hadRecentInput: false,
        maxInteractiveRedrawChars: 128 * 1024
      })
    ).toBe(false)
  })

  it('does not refresh East Asian output on a remote/serve Windows client without recent input', () => {
    // 原因：SSH/serve pane 是 win32 client 但不是 native ConPTY，渲染层不同；
    // 无最近输入时不能为每个 CJK 块付出刷新成本。
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('如果还在主', {
        isWindowsClient: true,
        isNativeWindowsConpty: false,
        hadRecentInput: false,
        maxInteractiveRedrawChars: 128 * 1024
      })
    ).toBe(false)
  })

  it('does not refresh plain ASCII agent output', () => {
    expect(windowsEastAsianOutputPrefersRenderRefresh('checkout worktree', NATIVE_CONPTY)).toBe(
      false
    )
  })

  it('skips bulk chunks larger than the interactive redraw bound', () => {
    const bulk = '如'.repeat(200)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh(bulk, {
        ...NATIVE_CONPTY,
        maxInteractiveRedrawChars: 100
      })
    ).toBe(false)
  })
})
