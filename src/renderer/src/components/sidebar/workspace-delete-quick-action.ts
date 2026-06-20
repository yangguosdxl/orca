export function canShowWorkspaceDeleteQuickAction(args: {
  isDeleting: boolean
  isMainWorktree: boolean
}): boolean {
  return !args.isDeleting && !args.isMainWorktree
}
