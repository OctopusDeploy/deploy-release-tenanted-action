import { getInputParameters } from '../../src/input-parameters'

test('get input parameters', () => {
  const inputParameters = getInputParameters()
  expect(inputParameters).toBeDefined()
  expect(inputParameters.environment).toBeDefined()
  expect(inputParameters.environment).toBe('Dev')
  expect(inputParameters.tenants).toBeDefined()
  expect(inputParameters.tenants[0]).toBe('Tenant A')
  expect(inputParameters.tenants[1]).toBe('Tenant B')
  expect(inputParameters.variables).toBeDefined()
  expect(inputParameters.variables?.get('foo')).toBe('quux')
  expect(inputParameters.variables?.get('bar')).toBe('xyzzy')
})
