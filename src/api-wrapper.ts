import { InputParameters } from './input-parameters'
import {
  Client,
  deployReleaseTenanted,
  CreateDeploymentTenantedCommandV1,
  DeploymentRepository,
  TenantRepository
} from '@octopusdeploy/api-client'

export interface DeploymentResult {
  serverTaskId: string
  tenantName: string
}

export async function createDeploymentFromInputs(
  client: Client,
  parameters: InputParameters
): Promise<DeploymentResult[]> {
  client.info('🐙 Deploying a release in Octopus Deploy...')

  const command: CreateDeploymentTenantedCommandV1 = {
    spaceName: parameters.space,
    ProjectName: parameters.project,
    ReleaseVersion: parameters.releaseNumber,
    EnvironmentName: parameters.environment,
    Tenants: parameters.tenants,
    TenantTags: parameters.tenantTags,
    UseGuidedFailure: parameters.useGuidedFailure,
    Variables: parameters.variables
  }

  const response = await deployReleaseTenanted(client, command)

  client.info(
    `🎉 ${response.DeploymentServerTasks.length} Deployment${
      response.DeploymentServerTasks.length > 1 ? 's' : ''
    } queued successfully!`
  )

  if (response.DeploymentServerTasks.length === 0) {
    throw new Error('Expected at least one deployment to be queued.')
  }
  if (
    response.DeploymentServerTasks[0].ServerTaskId === null ||
    response.DeploymentServerTasks[0].ServerTaskId === undefined
  ) {
    throw new Error('Server task id was not deserialized correctly.')
  }

  const deploymentIds = response.DeploymentServerTasks.map(x => x.DeploymentId)

  const deploymentRepository = new DeploymentRepository(client, parameters.space)
  const deployments = await deploymentRepository.list({ ids: deploymentIds, take: deploymentIds.length })

  const tenantIds = deployments.Items.map(d => d.TenantId || '')
  const tenantRepository = new TenantRepository(client, parameters.space)
  const tenants = await tenantRepository.list({ ids: tenantIds, take: tenantIds.length })

  const results = response.DeploymentServerTasks.map(x => {
    return {
      serverTaskId: x.ServerTaskId,
      tenantName: tenants.Items.filter(
        e => e.Id === deployments.Items.filter(d => d.TaskId === x.ServerTaskId)[0].TenantId
      )[0].Name
    }
  })

  return results
}
