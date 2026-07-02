import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  createTargetPnpmSteps,
  createPnpmSpawnSpec,
  findMissingCompiledOutputs,
  getArtifactPatterns,
  planBuild,
  parseArgs,
  resolveRequestedTargets,
  runBuildArtifacts
} from './build-artifacts.mjs'

describe('resolveRequestedTargets', () => {
  it('默认构建当前 Windows 平台包', () => {
    expect(resolveRequestedTargets({ requestedTarget: 'current', platform: 'win32' })).toEqual([
      'win'
    ])
  })

  it('支持一次选择全部平台', () => {
    expect(resolveRequestedTargets({ requestedTarget: 'all', platform: 'win32' })).toEqual([
      'win',
      'mac',
      'linux'
    ])
  })

  it('拒绝未知构建目标并给出中文错误', () => {
    expect(() =>
      resolveRequestedTargets({ requestedTarget: 'android', platform: 'win32' })
    ).toThrow('未知构建目标')
  })
})

describe('planBuild', () => {
  it('当前平台映射到已有 package 构建脚本', () => {
    expect(planBuild({ requestedTarget: 'current', platform: 'linux' })).toEqual([
      {
        target: 'linux',
        packageScript: 'build:linux',
        supported: true,
        skipReason: ''
      }
    ])
  })

  it('全部平台在本机只执行可本地构建的平台，并说明跳过原因', () => {
    expect(planBuild({ requestedTarget: 'all', platform: 'win32' })).toEqual([
      {
        target: 'win',
        packageScript: 'build:win',
        supported: true,
        skipReason: ''
      },
      {
        target: 'mac',
        packageScript: 'build:mac',
        supported: false,
        skipReason: 'macOS 包需要在 macOS 主机上构建'
      },
      {
        target: 'linux',
        packageScript: 'build:linux',
        supported: false,
        skipReason: 'Linux 包需要在 Linux 主机上构建'
      }
    ])
  })

  it('构建脚本只引用本地打包命令', () => {
    const forbiddenFragments = ['git tag', 'git push', 'gh workflow', 'npm publish', '--publish']
    const scripts = planBuild({ requestedTarget: 'all', platform: 'linux' })
      .map((entry) => entry.packageScript)
      .join(' ')

    for (const fragment of forbiddenFragments) {
      expect(scripts).not.toContain(fragment)
    }
  })
})

describe('getArtifactPatterns', () => {
  it('返回各平台可展示给用户的产物匹配规则', () => {
    expect(getArtifactPatterns(['win', 'mac', 'linux'])).toEqual([
      'dist/orca-windows-setup.exe',
      'dist/orca-macos-*.dmg',
      'dist/Orca-*-mac.zip',
      'dist/orca-linux*.AppImage',
      'dist/orca-ide_*_*.deb'
    ])
  })
})

describe('runBuildArtifacts', () => {
  it('dry-run 默认输出增量打包计划，不执行完整重建', async () => {
    const runCommand = vi.fn()
    const logs = []

    const result = await runBuildArtifacts({
      requestedTarget: 'current',
      platform: 'win32',
      dryRun: true,
      runCommand,
      log: (message) => logs.push(message)
    })

    expect(runCommand).not.toHaveBeenCalled()
    expect(result.builtTargets).toEqual(['win'])
    expect(logs.join('\n')).toContain('[构建] dry-run：不会执行实际构建命令')
    expect(logs.join('\n')).toContain('pnpm exec electron-builder')
    expect(logs.join('\n')).not.toContain('pnpm run build:win')
  })

  it('默认复用已有编译输出并输出结果文件路径', async () => {
    const runCommand = vi.fn(async () => {})
    const logs = []

    const result = await runBuildArtifacts({
      requestedTarget: 'current',
      platform: 'win32',
      dryRun: false,
      runCommand,
      findMissingOutputs: () => [],
      collectArtifacts: () => ['D:\\wann\\orca\\dist\\orca-windows-setup.exe'],
      log: (message) => logs.push(message)
    })

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'pnpm run ensure:electron-runtime'
      }),
      expect.objectContaining({ target: 'win' })
    )
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'pnpm exec electron-builder --config config/electron-builder.config.cjs --win'
      }),
      expect.objectContaining({ target: 'win' })
    )
    expect(runCommand).not.toHaveBeenCalledWith('build:win', expect.anything())
    expect(result.artifacts).toEqual(['D:\\wann\\orca\\dist\\orca-windows-setup.exe'])
    expect(logs.join('\n')).toContain('[构建] 结果文件：')
    expect(logs.join('\n')).toContain('D:\\wann\\orca\\dist\\orca-windows-setup.exe')
  })

  it('--rebuild 才执行完整平台构建脚本', async () => {
    const runCommand = vi.fn(async () => {})

    await runBuildArtifacts({
      requestedTarget: 'current',
      platform: 'win32',
      rebuild: true,
      runCommand,
      collectArtifacts: () => []
    })

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'pnpm run build:win'
      }),
      expect.objectContaining({ target: 'win' })
    )
  })

  it('默认增量模式缺少编译输出时提示使用 --rebuild', async () => {
    await expect(
      runBuildArtifacts({
        requestedTarget: 'current',
        platform: 'win32',
        runCommand: vi.fn(),
        findMissingOutputs: () => ['out/main/index.js']
      })
    ).rejects.toThrow('请加 --rebuild 执行完整重建')
  })
})

describe('createTargetPnpmSteps', () => {
  it('默认只打包已有编译输出，不重新执行 build:win', () => {
    expect(createTargetPnpmSteps('win', { rebuild: false })).toEqual([
      {
        label: 'pnpm run ensure:electron-runtime',
        pnpmArgs: ['run', 'ensure:electron-runtime']
      },
      {
        label: 'pnpm exec electron-builder --config config/electron-builder.config.cjs --win',
        pnpmArgs: [
          'exec',
          'electron-builder',
          '--config',
          'config/electron-builder.config.cjs',
          '--win'
        ]
      }
    ])
  })

  it('--rebuild 使用完整平台构建脚本', () => {
    expect(createTargetPnpmSteps('win', { rebuild: true })).toEqual([
      {
        label: 'pnpm run build:win',
        pnpmArgs: ['run', 'build:win']
      }
    ])
  })
})

describe('createPnpmSpawnSpec', () => {
  it('Windows 通过 cmd.exe 启动 pnpm.cmd，避免直接 spawn .cmd 失败', () => {
    expect(
      createPnpmSpawnSpec(['run', 'build:win'], {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      })
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'run', 'build:win']
    })
  })

  it('非 Windows 平台直接启动 pnpm', () => {
    expect(createPnpmSpawnSpec(['run', 'build:linux'], { platform: 'linux', env: {} })).toEqual({
      command: 'pnpm',
      args: ['run', 'build:linux']
    })
  })
})

describe('findMissingCompiledOutputs', () => {
  it('返回默认增量打包缺少的编译输出', () => {
    const existing = new Set([
      'D:\\repo\\out\\main\\index.js',
      'D:\\repo\\out\\renderer\\index.html'
    ])
    const missing = findMissingCompiledOutputs({
      cwd: 'D:\\repo',
      target: 'win',
      fsImpl: {
        existsSync: (path) => existing.has(path)
      }
    })

    expect(missing).toEqual(['out/preload/index.js', 'out/cli/index.js', 'out/relay'])
  })
})

describe('parseArgs', () => {
  it('兼容 pnpm run 传入的参数分隔符', () => {
    expect(parseArgs(['--', '--target', 'current', '--dry-run', '--rebuild'])).toEqual({
      requestedTarget: 'current',
      dryRun: true,
      rebuild: true,
      help: false
    })
  })
})

describe('scripts/build-artifacts.sh', () => {
  it('帮助信息说明 shell 包装器默认执行完整重建', () => {
    const result = spawnSync('sh', ['scripts/build-artifacts.sh', '--help'], {
      encoding: 'utf8'
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(0)
    expect(output).toContain('默认执行完整重建')
    expect(output).not.toContain('默认复用 out/ 编译输出')
  })

  it('没有指定目标时先询问用户，回车默认当前平台', () => {
    const result = spawnSync('sh', ['scripts/build-artifacts.sh', '--dry-run'], {
      input: '\n',
      encoding: 'utf8'
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(0)
    expect(output).toContain('请选择构建目标')
    expect(output).toContain('[构建] dry-run：不会执行实际构建命令')
    expect(output).toContain('pnpm run build:win')
    expect(output).not.toContain('pnpm exec electron-builder')
  })

  it('兼容 Windows 终端管道传入的 CRLF 回车', () => {
    const result = spawnSync('sh', ['scripts/build-artifacts.sh', '--dry-run'], {
      input: '\r\n',
      encoding: 'utf8'
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(0)
    expect(output).toContain('请选择构建目标')
    expect(output).toContain('[构建] dry-run：不会执行实际构建命令')
    expect(output).toContain('pnpm run build:win')
    expect(output).not.toContain('无效选项')
  })
})
