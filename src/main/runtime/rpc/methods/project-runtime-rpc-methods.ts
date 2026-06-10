import { z } from 'zod'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const ProjectHostSetupExistingFolder = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
  path: requiredString('Missing project path'),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString
})

export const PROJECT_RUNTIME_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'project.list',
    params: null,
    handler: (_params, { runtime }) => ({ projects: runtime.listProjects() })
  }),
  defineMethod({
    name: 'projectHostSetup.list',
    params: null,
    handler: (_params, { runtime }) => ({ setups: runtime.listProjectHostSetups() })
  }),
  defineMethod({
    name: 'projectHostSetup.setupExistingFolder',
    params: ProjectHostSetupExistingFolder,
    handler: async (params, { runtime }) => ({
      result: await runtime.setupProjectExistingFolder(params)
    })
  })
]
