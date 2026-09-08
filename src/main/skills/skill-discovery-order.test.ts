import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill } from '../../shared/skills'
import { sortDiscoveredSkills } from './skill-discovery-sources'

function skill(index: number): DiscoveredSkill {
  return {
    id: String(index),
    name: ['éclair', 'Eclair', 'item2', 'item10', 'Ångström', 'zebra', 'İstanbul'][index % 7],
    description: null,
    providers: ['codex'],
    sourceKind: 'home',
    sourceLabel: ['Home', 'hôme', 'Repo', 'repo'][index % 4],
    rootPath: '/skills',
    directoryPath: '/skills/example',
    skillFilePath: `/skills/${index % 13}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

// Preserve the original comparator as the ordering and operation-count oracle.
function compareOriginal(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.sourceLabel.localeCompare(b.sourceLabel, undefined, { sensitivity: 'base' }) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

afterEach(() => vi.restoreAllMocks())

describe('discovered skill ordering', () => {
  it('preserves name, source, path and stable ties with one collator per sort', () => {
    const skills = Array.from({ length: 2_000 }, (_, index) => skill(index))
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    const expected = [...skills].sort(compareOriginal)
    const optionedCalls = (): number =>
      localeCompare.mock.calls.filter((args) => args[2] !== undefined).length
    expect(optionedCalls()).toBeGreaterThan(10_000)
    localeCompare.mockClear()
    const NativeCollator = Intl.Collator
    const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })

    expect(sortDiscoveredSkills(skills)).toBe(skills)
    expect(skills.map(({ id }) => id)).toEqual(expected.map(({ id }) => id))
    expect(optionedCalls()).toBe(0)
    expect(construct).toHaveBeenCalledExactlyOnceWith(undefined, { sensitivity: 'base' })
    sortDiscoveredSkills([...skills])
    expect(construct).toHaveBeenCalledTimes(2)
  })

  it('does no comparison setup for empty or singleton discovery results', () => {
    const construct = vi.spyOn(Intl, 'Collator')
    for (const skills of [[], [skill(0)]]) {
      expect(sortDiscoveredSkills(skills)).toBe(skills)
    }
    expect(construct).not.toHaveBeenCalled()
  })
})
