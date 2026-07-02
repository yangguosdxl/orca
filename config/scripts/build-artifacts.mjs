#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGET_ORDER = ['win', 'mac', 'linux']
const ELECTRON_BUILDER_CONFIG_ARGS = ['--config', 'config/electron-builder.config.cjs']
const COMMON_COMPILED_OUTPUTS = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/cli/index.js',
  'out/relay'
]
const TARGET_CONFIG = {
  win: {
    packageScript: 'build:win',
    platform: 'win32',
    label: 'Windows',
    unsupportedReason: 'Windows 包需要在 Windows 主机上构建',
    incrementalSteps: [
      {
        label: 'pnpm run ensure:electron-runtime',
        pnpmArgs: ['run', 'ensure:electron-runtime']
      },
      {
        label: 'pnpm exec electron-builder --config config/electron-builder.config.cjs --win',
        pnpmArgs: ['exec', 'electron-builder', ...ELECTRON_BUILDER_CONFIG_ARGS, '--win']
      }
    ],
    artifactPatterns: ['dist/orca-windows-setup.exe'],
    artifactRegexes: [/^orca-windows-setup\.exe$/],
    requiredOutputs: []
  },
  mac: {
    packageScript: 'build:mac',
    platform: 'darwin',
    label: 'macOS',
    unsupportedReason: 'macOS 包需要在 macOS 主机上构建',
    incrementalSteps: [
      {
        label: 'pnpm run ensure:electron-runtime',
        pnpmArgs: ['run', 'ensure:electron-runtime']
      },
      {
        label: 'pnpm exec electron-builder --config config/electron-builder.config.cjs --mac',
        pnpmArgs: ['exec', 'electron-builder', ...ELECTRON_BUILDER_CONFIG_ARGS, '--mac']
      }
    ],
    artifactPatterns: ['dist/orca-macos-*.dmg', 'dist/Orca-*-mac.zip'],
    artifactRegexes: [/^orca-macos-.+\.dmg$/, /^Orca-.+-mac\.zip$/],
    requiredOutputs: ['native/computer-use-macos/.build/release/Orca Computer Use.app']
  },
  linux: {
    packageScript: 'build:linux',
    platform: 'linux',
    label: 'Linux',
    unsupportedReason: 'Linux 包需要在 Linux 主机上构建',
    incrementalSteps: [
      {
        label: 'pnpm run ensure:electron-runtime',
        pnpmArgs: ['run', 'ensure:electron-runtime']
      },
      {
        label:
          'pnpm exec electron-builder --config config/electron-builder.config.cjs --linux AppImage deb',
        pnpmArgs: [
          'exec',
          'electron-builder',
          ...ELECTRON_BUILDER_CONFIG_ARGS,
          '--linux',
          'AppImage',
          'deb'
        ]
      }
    ],
    artifactPatterns: ['dist/orca-linux*.AppImage', 'dist/orca-ide_*_*.deb'],
    artifactRegexes: [/^orca-linux.*\.AppImage$/, /^orca-ide_.+_.+\.deb$/],
    requiredOutputs: []
  }
}

function targetFromPlatform(platform) {
  if (platform === 'win32') {
    return 'win'
  }
  if (platform === 'darwin') {
    return 'mac'
  }
  if (platform === 'linux') {
    return 'linux'
  }
  throw new Error(`当前系统 ${platform} 暂不支持本地构建`)
}

export function resolveRequestedTargets({
  requestedTarget = 'current',
  platform = process.platform
}) {
  if (requestedTarget === 'current' || requestedTarget === '') {
    return [targetFromPlatform(platform)]
  }
  if (requestedTarget === 'all') {
    return [...TARGET_ORDER]
  }
  if (TARGET_ORDER.includes(requestedTarget)) {
    return [requestedTarget]
  }
  throw new Error(`未知构建目标：${requestedTarget}。可用值：current、all、win、mac、linux`)
}

export function planBuild({ requestedTarget = 'current', platform = process.platform } = {}) {
  return resolveRequestedTargets({ requestedTarget, platform }).map((target) => {
    const config = TARGET_CONFIG[target]
    const supported = config.platform === platform
    return {
      target,
      packageScript: config.packageScript,
      supported,
      skipReason: supported ? '' : config.unsupportedReason
    }
  })
}

export function getArtifactPatterns(targets) {
  return targets.flatMap((target) => TARGET_CONFIG[target]?.artifactPatterns ?? [])
}

export function collectArtifactPaths({
  cwd = process.cwd(),
  targets,
  outDir = 'dist',
  sinceMs = 0,
  fsImpl = { existsSync, readdirSync, statSync }
} = {}) {
  const artifactDir = resolve(cwd, outDir)
  if (!fsImpl.existsSync(artifactDir)) {
    return []
  }

  const regexes = targets.flatMap((target) => TARGET_CONFIG[target]?.artifactRegexes ?? [])
  const paths = []

  function visit(dir) {
    for (const name of fsImpl.readdirSync(dir)) {
      const fullPath = join(dir, name)
      const stat = fsImpl.statSync(fullPath)
      if (stat.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (stat.mtimeMs >= sinceMs && regexes.some((regex) => regex.test(name))) {
        paths.push(fullPath)
      }
    }
  }

  visit(artifactDir)
  return paths.sort()
}

export function createTargetPnpmSteps(target, { rebuild = false } = {}) {
  const config = TARGET_CONFIG[target]
  if (!config) {
    throw new Error(`未知构建目标：${target}`)
  }
  if (rebuild) {
    return [
      {
        label: `pnpm run ${config.packageScript}`,
        pnpmArgs: ['run', config.packageScript]
      }
    ]
  }
  return config.incrementalSteps.map((step) => ({
    label: step.label,
    pnpmArgs: [...step.pnpmArgs]
  }))
}

export function findMissingCompiledOutputs({
  cwd = process.cwd(),
  target,
  fsImpl = { existsSync }
} = {}) {
  const requiredOutputs = [
    ...COMMON_COMPILED_OUTPUTS,
    ...(TARGET_CONFIG[target]?.requiredOutputs ?? [])
  ]
  return requiredOutputs.filter((relativePath) => !fsImpl.existsSync(resolve(cwd, relativePath)))
}

export function createPnpmSpawnSpec(
  pnpmArgs,
  { platform = process.platform, env = process.env } = {}
) {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      // Windows 需要经由 cmd.exe 启动 .cmd，否则 Node 24 直接 spawn 会抛 EINVAL。
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArgs]
    }
  }
  return {
    command: 'pnpm',
    args: pnpmArgs
  }
}

export async function runPnpmScript(step, { cwd = process.cwd(), env = process.env } = {}) {
  const normalizedStep =
    typeof step === 'string' ? { label: `pnpm run ${step}`, pnpmArgs: ['run', step] } : step
  const { command, args } = createPnpmSpawnSpec(normalizedStep.pnpmArgs, {
    platform: process.platform,
    env
  })
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      reject(new Error(`无法启动 ${normalizedStep.label}：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const detail = signal ? `信号 ${signal}` : `退出码 ${code}`
      reject(new Error(`${normalizedStep.label} 构建失败：${detail}`))
    })
  })
}

export async function runBuildArtifacts({
  requestedTarget = 'current',
  platform = process.platform,
  dryRun = false,
  rebuild = false,
  cwd = process.cwd(),
  env = process.env,
  runCommand = runPnpmScript,
  findMissingOutputs = findMissingCompiledOutputs,
  collectArtifacts = collectArtifactPaths,
  log = console.log
} = {}) {
  const plan = planBuild({ requestedTarget, platform })
  const buildable = plan.filter((entry) => entry.supported)
  const skipped = plan.filter((entry) => !entry.supported)

  log(`[构建] 请求目标：${requestedTarget}`)
  log(`[构建] 模式：${rebuild ? '完整重建（--rebuild）' : '增量打包（复用 out/ 编译输出）'}`)
  if (dryRun) {
    log('[构建] dry-run：不会执行实际构建命令')
  }
  for (const entry of skipped) {
    log(`[构建] 跳过 ${TARGET_CONFIG[entry.target].label}：${entry.skipReason}`)
  }
  for (const entry of buildable) {
    for (const step of createTargetPnpmSteps(entry.target, { rebuild })) {
      log(`[构建] 计划 ${TARGET_CONFIG[entry.target].label}：${step.label}`)
    }
  }
  if (buildable.length === 0) {
    throw new Error('没有可在当前主机执行的构建目标')
  }

  const builtTargets = []
  const buildStartedAtMs = Date.now() - 2_000
  for (const entry of buildable) {
    if (!rebuild && !dryRun) {
      const missingOutputs = findMissingOutputs({ cwd, target: entry.target })
      if (missingOutputs.length > 0) {
        throw new Error(
          [
            '未找到可复用的编译输出，默认增量打包无法继续。',
            ...missingOutputs.map((relativePath) => `  ${relativePath}`),
            '请加 --rebuild 执行完整重建。'
          ].join('\n')
        )
      }
    }
    if (!dryRun) {
      log(`[构建] 开始 ${TARGET_CONFIG[entry.target].label}`)
      for (const step of createTargetPnpmSteps(entry.target, { rebuild })) {
        await runCommand(step, { target: entry.target, cwd, env })
      }
      log(`[构建] 完成 ${TARGET_CONFIG[entry.target].label}`)
    }
    builtTargets.push(entry.target)
  }

  if (dryRun) {
    log('[构建] dry-run：预期结果匹配规则：')
    for (const pattern of getArtifactPatterns(builtTargets)) {
      log(`  ${pattern}`)
    }
    return { plan, builtTargets, artifacts: [] }
  }

  const artifacts = collectArtifacts({ cwd, targets: builtTargets, sinceMs: buildStartedAtMs })
  if (artifacts.length === 0) {
    log('[构建] 未在 dist 目录找到本次构建结果文件')
  } else {
    log('[构建] 结果文件：')
    for (const artifactPath of artifacts) {
      log(artifactPath)
    }
  }

  return { plan, builtTargets, artifacts }
}

export function parseArgs(argv) {
  const parsed = {
    requestedTarget: 'current',
    dryRun: false,
    rebuild: false,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    }
    if (arg === '--target') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--target 需要传入 current、all、win、mac 或 linux')
      }
      parsed.requestedTarget = value
      index += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      parsed.requestedTarget = arg.slice('--target='.length)
      continue
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true
      continue
    }
    if (arg === '--rebuild') {
      parsed.rebuild = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }

  return parsed
}

function printHelp(log = console.log) {
  log(
    '用法：node config/scripts/build-artifacts.mjs [--target current|all|win|mac|linux] [--dry-run] [--rebuild]'
  )
  log('说明：默认复用 out/ 编译输出做增量打包；--rebuild 才执行完整重建。')
  log('安全边界：只执行本地构建，不发布、不打 tag、不 push。')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  await runBuildArtifacts({
    requestedTarget: args.requestedTarget,
    dryRun: args.dryRun,
    rebuild: args.rebuild
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[构建] 失败：${error.message}`)
    process.exit(1)
  })
}
