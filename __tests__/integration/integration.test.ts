import { createDeploymentFromInputs } from '../../src/api-wrapper'
// we use the Octopus API client to setup and teardown integration test data, it doesn't form part of create-release-action at this point
import {
  Client,
  ClientConfiguration,
  CreateReleaseCommandV1,
  DeploymentEnvironment,
  DeploymentProcessRepository,
  EnvironmentRepository,
  LifecycleRepository,
  Logger,
  PackageRequirement,
  Project,
  ProjectGroupRepository,
  ProjectRepository,
  ReleaseRepository,
  RunCondition,
  RunConditionForAction,
  ServerTaskDetails,
  ServerTaskWaiter,
  StartTrigger,
  TagSet,
  TagSetRepository,
  TenantedDeploymentMode,
  TenantRepository
} from '@octopusdeploy/api-client'
import { randomBytes } from 'crypto'
import { setOutput } from '@actions/core'
import { CaptureOutput } from '../test-helpers'
import { InputParameters } from '../../src/input-parameters'

// NOTE: These tests assume Octopus is running and connectable.
// In the build pipeline they are run as part of a build.yml file which populates
// OCTOPUS_TEST_URL and OCTOPUS_TEST_API_KEY environment variables pointing to docker
// containers that are also running. AND it assumes that 'octo' is in your PATH
//
// If you want to run these locally outside the build pipeline, you need to launch
// octopus yourself, and set OCTOPUS_TEST_CLI_PATH, OCTOPUS_TEST_URL and OCTOPUS_TEST_API_KEY appropriately,
// and put octo in your path somewhere.
// all resources created by this script have a GUID in
// their name so we they don't clash with prior test runs

const apiClientConfig: ClientConfiguration = {
  userAgentApp: 'Test',
  apiKey: process.env.OCTOPUS_TEST_API_KEY || 'API-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  instanceURL: process.env.OCTOPUS_TEST_URL || 'http://localhost:8050',
  space: process.env.OCTOPUS_TEST_SPACE || 'Default'
}

const runId = randomBytes(16).toString('hex')
const localProjectName = `project${runId}`
let localReleaseNumber = ''

async function createReleaseForTest(client: Client): Promise<void> {
  client.info('Creating a release in Octopus Deploy...')

  const command: CreateReleaseCommandV1 = {
    spaceName: apiClientConfig.space || 'Default',
    ProjectName: localProjectName
  }

  const releaseRepository = new ReleaseRepository(client, command.spaceName)
  const allocatedReleaseNumber = await releaseRepository.create(command)

  client.info(`Release ${allocatedReleaseNumber.ReleaseVersion} created successfully!`)

  localReleaseNumber = allocatedReleaseNumber.ReleaseVersion
}

describe('integration tests', () => {
  jest.setTimeout(100000)

  const standardInputParameters: InputParameters = {
    server: apiClientConfig.instanceURL,
    apiKey: apiClientConfig.apiKey,
    space: apiClientConfig.space || 'Default',
    project: localProjectName,
    releaseNumber: '',
    environment: 'Dev',
    tenants: ['Tenant A'],
    tenantTags: ['setA/tagB']
  }

  let apiClient: Client
  let project: Project

  beforeAll(async () => {
    apiClient = await Client.create(apiClientConfig)

    // pre-reqs: We need a project, which needs to have a deployment process

    const projectGroup = (await new ProjectGroupRepository(apiClient, standardInputParameters.space).list({ take: 1 }))
      .Items[0]
    if (!projectGroup) throw new Error("Can't find first projectGroup")

    let devEnv: DeploymentEnvironment
    let stagingEnv: DeploymentEnvironment
    const envRepository = new EnvironmentRepository(apiClient, standardInputParameters.space)
    let envs = await envRepository.list({ partialName: 'Dev' })
    if (envs.Items.filter(e => e.Name === 'Dev').length === 1) {
      devEnv = envs.Items.filter(e => e.Name === 'Dev')[0]
    } else {
      devEnv = await envRepository.create({ Name: 'Dev' })
    }
    envs = await envRepository.list({ partialName: 'Staging Demo' })
    if (envs.Items.filter(e => e.Name === 'Staging Demo').length === 1) {
      stagingEnv = envs.Items.filter(e => e.Name === 'Staging Demo')[0]
    } else {
      stagingEnv = await envRepository.create({ Name: 'Staging Demo' })
    }

    const lifecycleRepository = new LifecycleRepository(apiClient, standardInputParameters.space)
    const lifecycle = (await lifecycleRepository.list({ take: 1 })).Items[0]
    if (!lifecycle) throw new Error("Can't find first lifecycle")
    if (lifecycle.Phases.length === 0) {
      lifecycle.Phases.push({
        Id: 'test',
        Name: 'Testing',
        OptionalDeploymentTargets: [devEnv.Id, stagingEnv.Id],
        MinimumEnvironmentsBeforePromotion: 1,
        IsOptionalPhase: false
      })
      await lifecycleRepository.modify(lifecycle)
    }

    const projectRepository = new ProjectRepository(apiClient, standardInputParameters.space)
    project = await projectRepository.create({
      Name: localProjectName,
      LifecycleId: lifecycle.Id,
      ProjectGroupId: projectGroup.Id
    })

    project.TenantedDeploymentMode = TenantedDeploymentMode.Tenanted
    project = await projectRepository.modify(project)

    const deploymentProcessRepository = new DeploymentProcessRepository(apiClient, standardInputParameters.space)
    const deploymentProcess = await deploymentProcessRepository.get(project)
    deploymentProcess.Steps = [
      {
        Condition: RunCondition.Success,
        PackageRequirement: PackageRequirement.LetOctopusDecide,
        StartTrigger: StartTrigger.StartAfterPrevious,
        Id: '',
        Name: `step1-${runId}`,
        Properties: {},
        Actions: [
          {
            Id: '',
            Name: 'Run a Script',
            ActionType: 'Octopus.Script',
            Notes: null,
            IsDisabled: false,
            CanBeUsedForProjectVersioning: false,
            IsRequired: false,
            WorkerPoolId: null,
            Container: {
              Image: null,
              FeedId: null
            },
            WorkerPoolVariable: '',
            Environments: [],
            ExcludedEnvironments: [],
            Channels: [],
            TenantTags: [],
            Packages: [],
            Condition: RunConditionForAction.Success,
            Properties: {
              'Octopus.Action.RunOnServer': 'true',
              'Octopus.Action.Script.ScriptSource': 'Inline',
              'Octopus.Action.Script.Syntax': 'PowerShel',
              'Octopus.Action.Script.ScriptBody': "Write-Host 'hello'"
            }
          }
        ]
      }
    ]

    await deploymentProcessRepository.update(project, deploymentProcess)

    let setA: TagSet
    const tagSetRepository = new TagSetRepository(apiClient, apiClientConfig.space || 'Default')
    const tagSets = await tagSetRepository.list()
    if (tagSets.Items.filter(ts => ts.Name === 'setA').length > 0) {
      setA = tagSets.Items.filter(ts => ts.Name === 'setA')[0]
      if (setA.Tags.filter(t => t.Name === 'tagB').length === 0) {
        setA.Tags.push({ Name: 'tagB', Color: '#000000', Id: '', Description: '', CanonicalTagName: '', SortOrder: 1 })
        setA = await tagSetRepository.modify(setA)
      }
    } else {
      setA = await tagSetRepository.create({
        Name: 'setA',
        Tags: [{ Name: 'tagB', Color: '#000000' }]
      })
    }

    const projectEnvs: Record<string, string[]> = {}
    projectEnvs[project.Id] = [devEnv.Id]

    const tenantRepository = new TenantRepository(apiClient, apiClientConfig.space || 'Default')
    const tenants = await tenantRepository.list()
    if (tenants.Items.filter(e => e.Name === 'Tenant A').length === 0) {
      await tenantRepository.create({
        Name: 'Tenant A',
        ProjectEnvironments: projectEnvs
      })
    } else {
      let tenantA = tenants.Items.filter(e => e.Name === 'Tenant A')[0]
      tenantA.ProjectEnvironments = projectEnvs
      tenantA = await tenantRepository.modify(tenantA)
    }

    if (tenants.Items.filter(e => e.Name === 'Tenant B').length === 0) {
      await tenantRepository.create({
        Name: 'Tenant B',
        TenantTags: [setA.Tags[0].CanonicalTagName],
        ProjectEnvironments: projectEnvs
      })
    } else {
      const tenantB = tenants.Items.filter(e => e.Name === 'Tenant B')[0]
      tenantB.ProjectEnvironments = projectEnvs
      await tenantRepository.modify(tenantB)
    }
  })

  afterAll(async () => {
    if (process.env.GITHUB_ACTIONS) {
      // Sneaky: if we are running inside github actions, we *do not* cleanup the octopus server project data.
      // rather, we leave it lying around and setOutput the random project name so the GHA self-test can use it
      setOutput('gha_selftest_project_name', localProjectName)
      setOutput('gha_selftest_release_number', localReleaseNumber)
    } else {
      if (project) {
        const projectRepository = new ProjectRepository(apiClient, standardInputParameters.space)
        await projectRepository.del(project)
      }
    }
  })

  test('can deploy a release', async () => {
    const output = new CaptureOutput()

    const logger: Logger = {
      debug: message => output.debug(message),
      info: message => output.info(message),
      warn: message => output.warn(message),
      error: (message, err) => {
        if (err !== undefined) {
          output.error(err.message)
        } else {
          output.error(message)
        }
      }
    }

    const config: ClientConfiguration = {
      userAgentApp: 'Test',
      instanceURL: apiClientConfig.instanceURL,
      apiKey: apiClientConfig.apiKey,
      logging: logger
    }

    const client = await Client.create(config)

    await createReleaseForTest(client)
    standardInputParameters.releaseNumber = localReleaseNumber
    const result = await createDeploymentFromInputs(client, standardInputParameters)

    // The first release in the project, so it should always have 0.0.1
    expect(result.length).toBe(2)
    expect(result[0].serverTaskId).toContain('ServerTasks-')

    expect(output.getAllMessages()).toContain(`[INFO] 🎉 2 Deployments queued successfully!`)

    // wait for the deployment or the teardown will fail
    const waiter = new ServerTaskWaiter(client, standardInputParameters.space)
    await waiter.waitForServerTasksToComplete(
      result.map(r => r.serverTaskId),
      1000,
      60000,
      (serverTaskDetails: ServerTaskDetails): void => {
        // eslint-disable-next-line no-console
        console.log(
          `Waiting for task ${serverTaskDetails.Task.Id}. Current status: ${serverTaskDetails.Task.State}, completed: ${serverTaskDetails.Progress.ProgressPercentage}%`
        )
      }
    )
  })
})
