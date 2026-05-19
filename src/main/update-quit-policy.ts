export function shouldWaitForAsyncQuitCleanup(args: {
  daemonDisconnectDone: boolean
  isUpdaterInstallQuit: boolean
}): boolean {
  if (args.isUpdaterInstallQuit) {
    return false
  }
  return !args.daemonDisconnectDone
}
