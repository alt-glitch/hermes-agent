import { describe, expect, test } from 'vitest'

import {
  decodePetGalleryResponse,
  decodePetSelectResponse,
  type PetGalleryResponse
} from '../boundary/schema/PetResponses.ts'
import { petCursor, petMarker, petTag, petWindow, visiblePets } from '../logic/petPicker.ts'

const PLAIN = { slug: 'plain', displayName: 'Plain Friend', installed: false }
const OFFICIAL = { slug: 'official', displayName: 'Official Friend', installed: false, curated: true }
const INSTALLED = { slug: 'installed', displayName: 'Installed Friend', installed: true }
const ACTIVE = { slug: 'active', displayName: 'Active Friend', installed: true }
const HIDDEN = { slug: 'clawd-placeholder', displayName: 'Hidden', installed: true }

const GALLERY: PetGalleryResponse = {
  active: 'active',
  enabled: true,
  pets: [PLAIN, OFFICIAL, INSTALLED, ACTIVE, HIDDEN]
}

function pet(slug: string) {
  const found = GALLERY.pets.find(row => row.slug === slug)
  if (!found) throw new Error(`missing pet fixture: ${slug}`)
  return found
}

describe('Pet Picker Effect boundaries', () => {
  test('decodes gallery/select responses leniently and rejects malformed required fields', () => {
    const gallery = decodePetGalleryResponse({ ...GALLERY, future: 'compatible' })
    expect(gallery?.pets).toHaveLength(5)
    expect(gallery?.future).toBe('compatible')
    expect(decodePetGalleryResponse({ ...GALLERY, enabled: 'yes' })).toBeUndefined()
    expect(decodePetGalleryResponse({ enabled: false, active: '', pets: [{ slug: 'x' }] })).toBeUndefined()

    expect(
      decodePetSelectResponse({ ok: true, slug: 'active', displayName: 'Active Friend', future: 1 })
    ).toMatchObject({
      ok: true,
      slug: 'active'
    })
    expect(decodePetSelectResponse({ ok: true, slug: 'active' })).toBeUndefined()
  })
})

describe('Pet Picker pure model', () => {
  test('hides clawd placeholders and ranks active, installed, curated, then remaining pets stably', () => {
    expect(visiblePets(GALLERY, '').map(pet => pet.slug)).toEqual(['active', 'installed', 'official', 'plain'])
  })

  test('filters case-insensitively across display name and slug', () => {
    expect(visiblePets(GALLERY, 'OFFICIAL').map(pet => pet.slug)).toEqual(['official'])
    expect(visiblePets(GALLERY, 'friend').map(pet => pet.slug)).toEqual(['active', 'installed', 'official', 'plain'])
    expect(visiblePets(GALLERY, 'missing')).toEqual([])
  })

  test('clamps navigation and centers a bounded ten-row window', () => {
    const rows = Array.from({ length: 18 }, (_, index) => index)
    expect(petCursor(0, 0, 1)).toBe(0)
    expect(petCursor(18, 0, -1)).toBe(0)
    expect(petCursor(18, 17, 1)).toBe(17)
    expect(petWindow(rows, 9)).toEqual({ offset: 4, rows: rows.slice(4, 14) })
  })

  test('derives Ink-compatible active/installed markers and official tags', () => {
    expect(petMarker(pet('active'), GALLERY)).toBe('●')
    expect(petMarker(pet('installed'), GALLERY)).toBe('✓')
    expect(petMarker(pet('official'), GALLERY)).toBe(' ')
    expect(petTag(pet('official'))).toBe(' · official')
    expect(petTag(pet('installed'))).toBe('')
  })
})
