import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { readRelayWorkflow } from './relay-repository.mjs'

const workflow = readRelayWorkflow('push-deploy.yml')
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1)
  const end = workflow.indexOf('\n      - ', start + 1)
  const block = workflow.slice(start, end === -1 ? undefined : end)
  return block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length)
    .split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n')
}
const candidate = step('Deploy the candidate revision with no traffic')
const shift = step('Shift all traffic to the verified candidate')
const rollback = step('Roll traffic back to the previous revision')
const cleanup = step('Delete the rejected candidate revision')
const env = { SERVICE_NAME: 'push-test', GCP_PROJECT_ID: 'test', GCP_REGION: 'test',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', IMAGE: 'synthetic-image',
  CANDIDATE_REVISION: 'push-test-c123-1', ROLLBACK_REVISION: 'push-test-old',
  ROLLBACK_IMAGE: 'registry/push@sha256:' + 'a'.repeat(64), PUSH_MIN_INSTANCES: '1', PUSH_MAX_INSTANCES: '2' }

function exercise(body, setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'push-workflow-'))
  try {
    setup(dir)
    const run = spawnSync('bash', ['-c', body], { encoding: 'utf8', timeout: 10000, cwd: dir,
      env: { ...process.env, ...env, RUNNER_TEMP: dir, GITHUB_ENV: join(dir, 'env'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        TRACE: join(dir, 'trace'), STATE: join(dir, 'state') } })
    assert.equal(run.status, 0, run.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Workflow shell behavior is Linux-specific; these tests never call a real cloud CLI.
test('failed candidate discovery retains enough state to remove tag and revision', { skip: process.platform === 'win32' }, () => {
  exercise(`
    gcloud() {
      case "$*" in
        'run deploy '*) echo deployed > "$STATE" ;;
        'run services describe '*) return 1 ;;
        'run revisions list '*) echo "$CANDIDATE_REVISION" ;;
        *) echo "$*" >> "$TRACE" ;;
      esac
    }
    jq() { return 1; }
    ( ${candidate} )
    test "$?" != 0 || exit 1
    source "$GITHUB_ENV"
    test "$CANDIDATE_TAG" = c123-1 || exit 1
    test "$CANDIDATE_REVISION" = push-test-c123-1 || exit 1
    ( ${cleanup} ) || exit 1
    grep -q -- '--remove-tags c123-1' "$TRACE" || exit 1
    grep -q 'run revisions delete push-test-c123-1' "$TRACE" || exit 1
  `)
})

test('failed post-promotion read retains intent and restores previous traffic', { skip: process.platform === 'win32' }, () => {
  exercise(`
    gcloud() {
      case "$*" in
        'run services update-traffic '*) echo "$*" >> "$TRACE" ;;
        'run services describe '*) return 1 ;;
      esac
    }
    jq() { return 1; }
    ( ${shift} )
    test "$?" != 0 || exit 1
    source "$GITHUB_ENV"
    test "$TRAFFIC_SHIFT_ATTEMPTED" = true || exit 1
    gcloud() {
      case "$*" in
        'run services update-traffic '*) echo "$*" >> "$TRACE" ;;
        'run services describe '*) echo '{}' ;;
      esac
    }
    jq() { echo "$ROLLBACK_REVISION"; }
    ( ${rollback} ) || exit 1
    source "$GITHUB_ENV"
    test "$TRAFFIC_ROLLED_BACK" = true || exit 1
    grep -q -- '--to-revisions push-test-old=100' "$TRACE" || exit 1
  `)
})

test('ambiguous promotion failure also leaves rollback intent', { skip: process.platform === 'win32' }, () => {
  exercise(`
    gcloud() { return 1; }
    ( ${shift} )
    test "$?" != 0 || exit 1
    source "$GITHUB_ENV"
    test "$TRAFFIC_SHIFT_ATTEMPTED" = true
  `)
})

const activate = step('Retire inert validation and activate the verified image')
test('partial activation records the new revision before deploy and deletes its consumer', { skip: process.platform === 'win32' }, () => {
  exercise(`
    CANDIDATE_TAG=c123-1
    sleep() { :; }
    gcloud() {
      echo "$*" >> "$TRACE"
      case "$*" in
        'run deploy '*) return 1 ;;
        'run revisions list '*) echo "$CANDIDATE_REVISION" ;;
      esac
    }
    ( ${activate} )
    test "$?" != 0 || exit 1
    source "$GITHUB_ENV"
    test "$ACTIVATION_ATTEMPTED" = true || exit 1
    test "$CANDIDATE_REVISION" = push-test-a123-1 || exit 1
    test "$CANDIDATE_TAG" = a123-1 || exit 1
    ( ${cleanup} ) || exit 1
    grep -q 'run revisions delete push-test-c123-1' "$TRACE" || exit 1
    grep -q 'run revisions delete push-test-a123-1' "$TRACE" || exit 1
    grep -q -- '--remove-env-vars ORCA_PUSH_MODE' "$TRACE" || exit 1
    test "$(grep -n 'run revisions delete push-test-c123-1' "$TRACE" | cut -d: -f1)" -lt \
      "$(grep -n 'run deploy' "$TRACE" | cut -d: -f1)" || exit 1
  `)
})

test('failed validation retirement never activates another consumer', { skip: process.platform === 'win32' }, () => {
  exercise(`
    CANDIDATE_TAG=c123-1
    gcloud() {
      echo "$*" >> "$TRACE"
      case "$*" in
        'run revisions delete '*) return 1 ;;
      esac
    }
    ( ${activate} )
    test "$?" != 0 || exit 1
    ! grep -q 'run deploy' "$TRACE" || exit 1
    ! grep -q ACTIVATION_ATTEMPTED "$GITHUB_ENV" 2>/dev/null || exit 1
  `)
})

const capability = step('Require image support for inert validation')
for (const [label, source, expected] of [
  ['old image', 'export function loadPushConfig() { return {}; }', 1],
  ['invalid mode accepted', 'export function loadPushConfig(env) { return { mode: env.ORCA_PUSH_MODE }; }', 1],
  ['validation supported', `export function loadPushConfig(env) {
    if (env.ORCA_PUSH_MODE !== 'validation') throw new Error('invalid mode');
    return { mode: 'validation' };
  }`, 0]
]) {
  test(`pre-production image smoke: ${label}`, { skip: process.platform === 'win32' }, () => {
    exercise(`
      docker() { node "\${@: -3}"; }
      ( ${capability} )
      test "$?" = ${expected}
    `, (dir) => {
      const dist = join(dir, 'apps', 'push', 'dist')
      mkdirSync(dist, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
      writeFileSync(join(dist, 'config.js'), source)
    })
  })
}

const restore = step('Restore the known-good service template')
const priorSpec = { serviceAccountName: 'runtime@test', containerConcurrency: 40,
  containers: [{ image: env.ROLLBACK_IMAGE, env: [
    { name: 'ORCA_PUSH_DATABASE_URL', valueFrom: { secretKeyRef: { name: 'database', key: '7' } } },
    { name: 'ORCA_PUSH_DATABASE_POOL_MAX', value: '2' }
  ] }] }
const recoveredService = { spec: { template: { spec: priorSpec, metadata: { annotations: {
  'autoscaling.knative.dev/minScale': '1', 'autoscaling.knative.dev/maxScale': '2'
} } } }, status: { traffic: [{ revisionName: env.ROLLBACK_REVISION, percent: 100 }] } }
function recoveryFiles(dir, service = recoveredService) {
  writeFileSync(join(dir, 'push-rollback-revision.json'), JSON.stringify({ spec: priorSpec }))
  writeFileSync(join(dir, 'recovered.json'), JSON.stringify(service))
}

test('recovery requires cleanup success and restores no traffic before verified rollback', { skip: process.platform === 'win32' }, () => {
  const block = workflow.slice(workflow.indexOf('- name: Restore the known-good service template'))
  assert.match(block, /env.VALIDATION_DEPLOY_ATTEMPTED == 'true' && env.CANDIDATE_DELETED == 'true'/)
  assert.ok(workflow.indexOf('- name: Delete the rejected candidate revision') <
    workflow.indexOf('- name: Restore the known-good service template'))
  exercise(`
    TRAFFIC_SHIFT_ATTEMPTED=true
    gcloud() { echo unexpected >> "$TRACE"; }
    ( ${restore} )
    test "$?" != 0 || exit 1
    test ! -e "$TRACE"
  `)
})

for (const absent of [false, true]) {
  test(`failed validation restores known-good template after candidate ${absent ? 'was never created' : 'deletion'}`, { skip: process.platform === 'win32' }, () => {
    exercise(`
      CANDIDATE_TAG=c123-1
      sleep() { echo shutdown-allowance >> "$TRACE"; }
      gcloud() {
        echo "$*" >> "$TRACE"
        case "$*" in
          'run revisions list '*) ${absent ? ':' : 'echo "$CANDIDATE_REVISION"'} ;;
          'run services describe '*) cat "$RUNNER_TEMP/recovered.json" ;;
        esac
      }
      ( ${cleanup} ) || exit 1
      source "$GITHUB_ENV"
      test "$CANDIDATE_DELETED" = true || exit 1
      ( ${restore} ) || exit 1
      source "$GITHUB_ENV"
      test "$TEMPLATE_RESTORED" = true || exit 1
      grep -q -- '--image registry/push@sha256:' "$TRACE" || exit 1
      grep -q -- '--remove-env-vars ORCA_PUSH_MODE --no-traffic' "$TRACE" || exit 1
      test "$(grep -n shutdown-allowance "$TRACE" | cut -d: -f1)" -lt \
        "$(grep -n 'run deploy' "$TRACE" | cut -d: -f1)"
    `, recoveryFiles)
  })
}

test('failed candidate deletion does not authorize template recovery', { skip: process.platform === 'win32' }, () => {
  exercise(`
    gcloud() {
      case "$*" in
        'run revisions list '*) echo "$CANDIDATE_REVISION" ;;
        'run revisions delete '*) return 1 ;;
      esac
    }
    ( ${cleanup} )
    test "$?" != 0 || exit 1
    ! grep -q CANDIDATE_DELETED=true "$GITHUB_ENV" 2>/dev/null
  `)
})

for (const defect of ['runtime', 'secret', 'mode', 'image', 'traffic', 'scaling', 'deploy']) {
  test(`template recovery rejects ${defect} failure and records attempted revision`, { skip: process.platform === 'win32' }, () => {
    const service = structuredClone(recoveredService)
    if (defect === 'runtime') service.spec.template.spec.serviceAccountName = 'wrong@test'
    if (defect === 'secret') service.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key = '8'
    if (defect === 'mode') service.spec.template.spec.containers[0].env.push({ name: 'ORCA_PUSH_MODE', value: 'validation' })
    if (defect === 'image') service.spec.template.spec.containers[0].image = 'rejected'
    if (defect === 'traffic') service.status.traffic[0].revisionName = 'rejected'
    if (defect === 'scaling') service.spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'] = '3'
    exercise(`
      sleep() { :; }
      gcloud() {
        case "$*" in
          'run deploy '*) ${defect === 'deploy' ? 'return 1' : ':'} ;;
          'run services describe '*) cat "$RUNNER_TEMP/recovered.json" ;;
        esac
      }
      ( ${restore} )
      test "$?" != 0 || exit 1
      source "$GITHUB_ENV"
      test "$TEMPLATE_RECOVERY_REVISION" = push-test-r123-1 || exit 1
      test -z "\${TEMPLATE_RESTORED:-}"
    `, (dir) => recoveryFiles(dir, service))
  })
}

const retireRecovery = step('Retire the template recovery revision')
for (const absent of [false, true]) {
  test(`recovery retirement handles ${absent ? 'partial creation without a revision' : 'an existing recovery consumer'}`, { skip: process.platform === 'win32' }, () => {
    exercise(`
      TEMPLATE_RECOVERY_REVISION=push-test-r123-1
      sleep() { echo shutdown-allowance >> "$TRACE"; }
      gcloud() {
        echo "$*" >> "$TRACE"
        case "$*" in
          'run revisions list '*) ${absent ? ':' : 'echo "$TEMPLATE_RECOVERY_REVISION"'} ;;
        esac
      }
      ( ${retireRecovery} ) || exit 1
      ${absent ? '!' : ''} grep -q 'run revisions delete' "$TRACE" || exit 1
      grep -q shutdown-allowance "$TRACE"
    `)
  })
}

test('recovery retirement runs after success or failure without mutating the restored template', () => {
  const block = workflow.slice(workflow.indexOf('- name: Retire the template recovery revision'),
    workflow.indexOf('- name: Drop the candidate traffic tag'))
  assert.match(block, /always\(\) && env.TEMPLATE_RECOVERY_REVISION != ''/)
  assert.doesNotMatch(retireRecovery, /run (deploy|services update|services replace)/)
  assert.match(workflow, /image="\$\(jq -er '\.status.imageDigest'/)
})
